from databricks.sdk import WorkspaceClient
from pyspark.sql import DataFrame

from mda_query_engine import __version__
from mda_query_engine.telemetry import verify_workspace_client
from .analyze.query.query_builder import QueryBuilder


class MeasurementDBConfig:
    """
    Configuration for a :class:`MeasurementDB`: where to read each silver-layer
    table from and how to resolve table locations.

    Use the :meth:`for_unity_catalog` factory for the standard Unity Catalog
    layout, or pass table paths explicitly to the constructor for non-default
    setups.

    Attributes
    ----------
    container_tags_table : str or None
        Full path to the ``container_tags`` table.
    container_metrics_table : str or None
        Full path to the ``container_metrics`` table.
    channel_tags_table : str or None
        Full path to the ``channel_tags`` table.
    channel_metrics_table : str or None
        Full path to the ``channel_metrics`` table.
    channels_uri : str or None
        Full path to the ``channels`` table.
    channel_mapping_table : str or None
        Full path to the ``channel_mapping`` (alias) table. Required when
        using ``QueryBuilder.channel_with_alias()``.
    table_locations : str
        How table paths should be resolved by :meth:`MeasurementDB._read_table`.
        ``"unity_catalog"`` for ``catalog.schema.table`` references, the
        default ``"external_locations"`` for Delta paths, and ``"debug"`` for
        in-memory test fixtures.
    """

    def __init__(
        self,
        container_tags_table=None,
        container_metrics_table=None,
        channel_tags_table=None,
        channel_metrics_table=None,
        channels_uri=None,
        channel_mapping_table=None,
        table_locations: str = "external_locations",
    ):
        """
        Initialize a MeasurementDBConfig with explicit table paths.

        Parameters
        ----------
        container_tags_table : str, optional
            Full path to the ``container_tags`` table.
        container_metrics_table : str, optional
            Full path to the ``container_metrics`` table.
        channel_tags_table : str, optional
            Full path to the ``channel_tags`` table.
        channel_metrics_table : str, optional
            Full path to the ``channel_metrics`` table.
        channels_uri : str, optional
            Full path to the ``channels`` table.
        channel_mapping_table : str, optional
            Full path to the ``channel_mapping`` (alias) table. Required
            when using ``QueryBuilder.channel_with_alias()``.
        table_locations : str, optional
            One of ``"external_locations"`` (default), ``"unity_catalog"``,
            or ``"debug"``. Controls how :meth:`MeasurementDB._read_table`
            resolves the paths above.
        """
        self.container_tags_table = container_tags_table
        self.container_metrics_table = container_metrics_table
        self.channel_tags_table = channel_tags_table
        self.channel_metrics_table = channel_metrics_table
        self.channels_uri = channels_uri
        self.channel_mapping_table = channel_mapping_table
        self.table_locations = table_locations
        self.debug_tables = None

    @staticmethod
    def for_unity_catalog(
        catalog_name: str,
        core_schema_name: str = "core",
        channel_mapping_table: str | None = None,
    ):
        """
        Build a config pointing at the standard Unity Catalog silver layout.

        Resolves all five silver tables under
        ``{catalog_name}.{core_schema_name}.*`` and sets
        ``table_locations = "unity_catalog"`` so the engine reads them via
        ``spark.read.table(...)``.

        Parameters
        ----------
        catalog_name : str
            Unity Catalog name.
        core_schema_name : str, optional
            Schema name within the catalog. Defaults to ``"core"``.
        channel_mapping_table : str, optional
            Full Unity Catalog path to the channel-alias mapping table.
            Required when using ``QueryBuilder.channel_with_alias()``
            (currently supported by ``KeyValueStoreSolver``).

        Returns
        -------
        MeasurementDBConfig
            A config instance with all silver table paths populated.
        """
        return MeasurementDBConfig(
            container_tags_table=f"{catalog_name}.{core_schema_name}.container_tags",
            container_metrics_table=f"{catalog_name}.{core_schema_name}.container_metrics",
            channel_tags_table=f"{catalog_name}.{core_schema_name}.channel_tags",
            channel_metrics_table=f"{catalog_name}.{core_schema_name}.channel_metrics",
            channels_uri=f"{catalog_name}.{core_schema_name}.channels",
            channel_mapping_table=channel_mapping_table,
            table_locations="unity_catalog",
        )

    @staticmethod
    def for_debug(debug_tables):
        """
        Build a config that reads silver tables from an in-memory dictionary.

        Used by tests to inject pre-built DataFrames without touching real
        storage.

        Parameters
        ----------
        debug_tables : dict[str, pyspark.sql.DataFrame]
            Map of logical table name (e.g. ``"container_tags"``) to a
            DataFrame providing that table's contents.

        Returns
        -------
        MeasurementDBConfig
            A config with ``table_locations = "debug"`` and the supplied
            ``debug_tables`` attached.
        """
        cfg = MeasurementDBConfig(
            container_tags_table="container_tags",
            container_metrics_table="container_metrics",
            channel_tags_table="channel_tags",
            channel_metrics_table="channel_metrics",
            channels_uri="channels",
            table_locations="debug",
        )
        cfg.debug_tables = debug_tables
        return cfg


class MeasurementDB:
    """
    Handle to the silver-layer measurement database.

    Wraps a :class:`MeasurementDBConfig` and gives the rest of the engine a
    single object through which to load any of the five silver tables. The
    public TSAL surface accessed via :attr:`query` (e.g.
    ``db.query.channel(channel_name="Engine_RPM")``) is built on top of this
    handle.
    """

    def __init__(self, config: MeasurementDBConfig, ws: WorkspaceClient):
        """
        Initialize the MeasurementDB.

        Parameters
        ----------
        config : MeasurementDBConfig
            Configuration describing where each silver-layer table lives.
        ws : databricks.sdk.WorkspaceClient
            Authenticated workspace client used for telemetry.
        """
        self.config = config
        self.ws = verify_workspace_client(ws, "databricks-impulse", __version__)

    @property
    def query(self):
        """
        TSAL query entrypoint.

        Returns
        -------
        QueryBuilder
            A fresh :class:`QueryBuilder` bound to this database. Use it
            to compose tag/metric filters and channel/metric selectors,
            e.g. ``db.query.channel(channel_name="Engine_RPM")`` or
            ``db.query.havingTag(vehicle_key="Seat_Leon")``.
        """
        return QueryBuilder(db=self)

    def _read_table(self, spark, table_name):
        # if not DeltaTable.isDeltaTable(spark, table_name):
        #    raise Exception(f"Table not found: `{table_name}`")
        if self.config.table_locations == "unity_catalog":
            return spark.read.table(table_name)
        elif self.config.table_locations == "debug":
            return self.config.debug_tables[table_name]
        return spark.read.format("delta").load(table_name)

    def container_tags(self, spark) -> DataFrame:
        """
        Load the ``container_tags`` silver table as a Spark DataFrame.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``container_tags`` table.
        """
        return self._read_table(spark, self.config.container_tags_table)

    def container_metrics(self, spark) -> DataFrame:
        """
        Load the ``container_metrics`` silver table as a Spark DataFrame.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``container_metrics`` table.
        """
        return self._read_table(spark, self.config.container_metrics_table)

    def channel_tags(self, spark) -> DataFrame:
        """
        Load the ``channel_tags`` silver table as a Spark DataFrame.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``channel_tags`` table.
        """
        return self._read_table(spark, self.config.channel_tags_table)

    def channel_metrics(self, spark) -> DataFrame:
        """
        Load the ``channel_metrics`` silver table as a Spark DataFrame.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``channel_metrics`` table.
        """
        return self._read_table(spark, self.config.channel_metrics_table)

    def channels(self, spark) -> DataFrame:
        """
        Load the ``channels`` silver table as a Spark DataFrame.

        The schema depends on the configured ``data_type``: RLE format
        (default) has ``tstart`` and ``tend`` columns; raw format has a
        single ``timestamp`` column.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``channels`` table.
        """
        return self._read_table(spark, self.config.channels_uri)

    def channel_mapping(self, spark) -> DataFrame:
        """
        Load the ``channel_mapping`` (alias) silver table as a Spark DataFrame.

        Parameters
        ----------
        spark : SparkSession
            Active Spark session used to read the table.

        Returns
        -------
        pyspark.sql.DataFrame
            The ``channel_mapping`` table.

        Raises
        ------
        ValueError
            If ``channel_mapping_table`` is not configured.
        """
        if self.config.channel_mapping_table is None:
            raise ValueError("channel_mapping_table is not configured")
        return self._read_table(spark, self.config.channel_mapping_table)

    def channel_uri(self):
        """
        Return the configured ``channels`` table path.

        Used by solvers that need the URI directly (for example to load
        per-container blobs). This does not perform any I/O.

        Returns
        -------
        str
            The channels-table path from this DB's
            :class:`MeasurementDBConfig`.
        """
        return self.config.channels_uri


class InMemoryMeasurementDB(MeasurementDB):
    @property
    def query(self):
        pass

    def add(self, ts, container_tags, measurement_tags):
        pass

    def container_tags(self, spark) -> DataFrame:
        return self._read_table(spark, self.config.container_tags_table)

    def container_metrics(self, spark) -> DataFrame:
        return self._read_table(spark, self.config.container_metrics_table)

    def channel_tags(self, spark) -> DataFrame:
        return self._read_table(spark, self.config.channel_tags_table)

    def channel_metrics(self, spark) -> DataFrame:
        return self._read_table(spark, self.config.channel_metrics_table)

    def channels(self, spark) -> DataFrame:
        return self._read_table(spark, self.config.channels_uri)

    def channel_uri(self):
        return self.config.channels_uri
