# A2D2 Bus-Signal & Camera Ingestion Demo

This demo ingests one recording from the **A2D2 (Audi Autonomous Driving Dataset)** into
the Impulse silver-layer model and fetches a small, evenly-sampled set of front-center
camera images so they can be matched to the bus signals by time.

The notebook [`a2d2_ingestion.ipynb`](./a2d2_ingestion.ipynb), run on Databricks:

1. Downloads the A2D2 **bus-signals** tar for recording `20190401_121727` at runtime into
   a Unity Catalog Volume, parses the 22 vehicle-bus channels (acceleration, angular
   velocity, GPS, steering, brake pressure, vehicle speed, …) and writes them into the
   Impulse silver-layer tables (`*_container_metrics`, `*_container_tags`,
   `*_channel_metrics`, `*_channel_tags`, `*_channels`) — queryable with TSAL exactly like
   the other Impulse demos.
2. Fetches an **evenly-sampled subset of front-center camera frames** (PNG + per-frame
   `cam_tstamp`) into the same Volume and records them in a small `*_camera_frames` table,
   so images can be joined to the bus signals on time.

## ⚠️ Dataset license — important

The A2D2 dataset is published by **Audi AG** under the
**Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)** license:
<https://creativecommons.org/licenses/by-nd/4.0/>. Source: <https://www.a2d2.audi/>.
Dataset paper: Geyer et al., 2020, *A2D2: Audi Autonomous Driving Dataset*,
arXiv:2004.06320.

Because the **NoDerivatives** clause forbids distributing the dataset or any derivative of
it, **this repository does not contain or redistribute any A2D2 data**. The notebook
downloads the data **at runtime, from the official source, into your own Databricks
workspace**, and all parsed tables and extracted images are written to **your own** Unity
Catalog. **Do not commit any downloaded or derived data** — the local `.gitignore` guards
against this, and the notebook must be committed with its outputs cleared.

## Prerequisites

- A Databricks workspace with **Unity Catalog** enabled.
- **Serverless** compute or a cluster on **DBR 14+** (Python 3.10+).
- Privilege to **create a schema and a volume** in the target catalog.
- **Internet egress to AWS S3** (`eu-central-1`); the source supports HTTP Range requests.
- Volume free space ≈ `images_per_second × bus_window_seconds × 3.6 MB` (a few hundred MB
  for a demo) — **not** the full 98 GB camera archive: only a time-sampled subset of images
  within the bus window is downloaded.

## How to run

1. Import `a2d2_ingestion.ipynb` into your workspace (or clone the repo as a Git folder).
2. Attach to serverless / a DBR 14+ cluster and run cell 1, then fill the widgets:
   - `catalog`, `schema` — where the silver tables and volume are created.
   - `table_prefix` (default `a2d2`) — prefix for the generated tables.
   - `volume` (default `a2d2_raw`) — UC Volume used for the runtime download.
   - `download_images` (default `true`) — set `false` to ingest only the bus signals.
   - `images_per_second` (default `0.1`) — how many camera frames per second to extract
     across the bus time window (e.g. `0.1` ≈ one frame every 10 s). Only frames whose
     `cam_tstamp` falls inside the bus recording's time window are fetched.
   - `index_scan_limit` (default `20000`) — caps the camera-tar header walk. Because the
     tar's storage order is random, a bounded scan still spans the whole drive's time
     range; set `0` to index every frame for exact whole-drive coverage (longer one-time
     walk, cached).
   - `skip_download_if_present` (default `true`), `drop_created_tables` (default `false`).
3. Run top to bottom. The final cells validate a TSAL round-trip on `vehicle_speed` and,
   when images are enabled, render a sample frame and join it to the bus data by time.

The same TSAL queries, events, and aggregations shown in
[`../getting_started.ipynb`](../getting_started.ipynb) and
[`../reporting_pipeline.ipynb`](../reporting_pipeline.ipynb) work against the tables this
notebook produces.
