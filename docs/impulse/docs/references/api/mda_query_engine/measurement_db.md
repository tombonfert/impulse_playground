---
sidebar_label: measurement_db
title: mda_query_engine.measurement_db
---

## MeasurementDBConfig

```python
class MeasurementDBConfig()
```

Configuration for a :class:`MeasurementDB`: where to read each silver-layer

table from and how to resolve table locations.

Use the :meth:`for_unity_catalog` factory for the standard Unity Catalog
layout, or pass table paths explicitly to the constructor for non-default
setups.

**Arguments**:

- `container_tags_table` (`str or None`): Full path to the ``container_tags`` table.
- `container_metrics_table` (`str or None`): Full path to the ``container_metrics`` table.
- `channel_tags_table` (`str or None`): Full path to the ``channel_tags`` table.
- `channel_metrics_table` (`str or None`): Full path to the ``channel_metrics`` table.
- `channels_uri` (`str or None`): Full path to the ``channels`` table.
- `channel_mapping_table` (`str or None`): Full path to the ``channel_mapping`` (alias) table. Required when
using ``QueryBuilder.channel_with_alias()``.
- `table_locations` (`str`): How table paths should be resolved by :meth:`MeasurementDB._read_table`.
``"unity_catalog"`` for ``catalog.schema.table`` references, the
default ``"external_locations"`` for Delta paths, and ``"debug"`` for
in-memory test fixtures.

#### \_\_init\_\_

```python
def __init__(container_tags_table=None,
             container_metrics_table=None,
             channel_tags_table=None,
             channel_metrics_table=None,
             channels_uri=None,
             channel_mapping_table=None,
             table_locations: str = "external_locations")
```

Initialize a MeasurementDBConfig with explicit table paths.

**Arguments**:

- `container_tags_table` (`str`): Full path to the ``container_tags`` table.
- `container_metrics_table` (`str`): Full path to the ``container_metrics`` table.
- `channel_tags_table` (`str`): Full path to the ``channel_tags`` table.
- `channel_metrics_table` (`str`): Full path to the ``channel_metrics`` table.
- `channels_uri` (`str`): Full path to the ``channels`` table.
- `channel_mapping_table` (`str`): Full path to the ``channel_mapping`` (alias) table. Required
when using ``QueryBuilder.channel_with_alias()``.
- `table_locations` (`str`): One of ``"external_locations"`` (default), ``"unity_catalog"``,
or ``"debug"``. Controls how :meth:`MeasurementDB._read_table`
resolves the paths above.

#### for\_unity\_catalog

```python
def for_unity_catalog(catalog_name: str,
                      core_schema_name: str = "core",
                      channel_mapping_table: str | None = None)
```

Build a config pointing at the standard Unity Catalog silver layout.

Resolves all five silver tables under
``{catalog_name}.{core_schema_name}.*`` and sets
``table_locations = "unity_catalog"`` so the engine reads them via
``spark.read.table(...)``.

**Arguments**:

- `catalog_name` (`str`): Unity Catalog name.
- `core_schema_name` (`str`): Schema name within the catalog. Defaults to ``"core"``.
- `channel_mapping_table` (`str`): Full Unity Catalog path to the channel-alias mapping table.
Required when using ``QueryBuilder.channel_with_alias()``
(currently supported by ``KeyValueStoreSolver``).

**Returns**:

`MeasurementDBConfig`: A config instance with all silver table paths populated.

#### for\_debug

```python
def for_debug(debug_tables)
```

Build a config that reads silver tables from an in-memory dictionary.

Used by tests to inject pre-built DataFrames without touching real
storage.

**Arguments**:

- `debug_tables` (`dict[str, pyspark.sql.DataFrame]`): Map of logical table name (e.g. ``"container_tags"``) to a
DataFrame providing that table's contents.

**Returns**:

`MeasurementDBConfig`: A config with ``table_locations = "debug"`` and the supplied
``debug_tables`` attached.

## MeasurementDB

```python
class MeasurementDB()
```

Handle to the silver-layer measurement database.

Wraps a :class:`MeasurementDBConfig` and gives the rest of the engine a
single object through which to load any of the five silver tables. The
public TSAL surface accessed via :attr:`query` (e.g.
``db.query.channel(channel_name="Engine_RPM")``) is built on top of this
handle.


#### \_\_init\_\_

```python
def __init__(config: MeasurementDBConfig, ws: WorkspaceClient)
```

Initialize the MeasurementDB.

**Arguments**:

- `config` (`MeasurementDBConfig`): Configuration describing where each silver-layer table lives.
- `ws` (`databricks.sdk.WorkspaceClient`): Authenticated workspace client used for telemetry.

#### query

```python
def query()
```

TSAL query entrypoint.

**Returns**:

`QueryBuilder`: A fresh :class:`QueryBuilder` bound to this database. Use it
to compose tag/metric filters and channel/metric selectors,
e.g. ``db.query.channel(channel_name="Engine_RPM")`` or
``db.query.havingTag(vehicle_key="Seat_Leon")``.

#### container\_tags

```python
def container_tags(spark) -> DataFrame
```

Load the ``container_tags`` silver table as a Spark DataFrame.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Returns**:

`pyspark.sql.DataFrame`: The ``container_tags`` table.

#### container\_metrics

```python
def container_metrics(spark) -> DataFrame
```

Load the ``container_metrics`` silver table as a Spark DataFrame.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Returns**:

`pyspark.sql.DataFrame`: The ``container_metrics`` table.

#### channel\_tags

```python
def channel_tags(spark) -> DataFrame
```

Load the ``channel_tags`` silver table as a Spark DataFrame.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Returns**:

`pyspark.sql.DataFrame`: The ``channel_tags`` table.

#### channel\_metrics

```python
def channel_metrics(spark) -> DataFrame
```

Load the ``channel_metrics`` silver table as a Spark DataFrame.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Returns**:

`pyspark.sql.DataFrame`: The ``channel_metrics`` table.

#### channels

```python
def channels(spark) -> DataFrame
```

Load the ``channels`` silver table as a Spark DataFrame.

The schema depends on the configured ``data_type``: RLE format
(default) has ``tstart`` and ``tend`` columns; raw format has a
single ``timestamp`` column.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Returns**:

`pyspark.sql.DataFrame`: The ``channels`` table.

#### channel\_mapping

```python
def channel_mapping(spark) -> DataFrame
```

Load the ``channel_mapping`` (alias) silver table as a Spark DataFrame.

**Arguments**:

- `spark` (`SparkSession`): Active Spark session used to read the table.

**Raises**:

- `ValueError`: If ``channel_mapping_table`` is not configured.

**Returns**:

`pyspark.sql.DataFrame`: The ``channel_mapping`` table.

#### channel\_uri

```python
def channel_uri()
```

Return the configured ``channels`` table path.

Used by solvers that need the URI directly (for example to load
per-container blobs). This does not perform any I/O.

**Returns**:

`str`: The channels-table path from this DB's
:class:`MeasurementDBConfig`.

