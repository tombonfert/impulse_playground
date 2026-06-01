# Impulse Event Explorer — A2D2 ADAS demo

An **end-to-end ADAS demo on Databricks**, built on the **Impulse** time-series library. It takes
real driving recordings from the **A2D2 (Audi Autonomous Driving Dataset)** and turns them into
**explainable, safety-relevant driving events** you can explore on a map — fusing **vehicle-bus
signals** with **camera perception**, mining safety events with Impulse, **verifying each event with a
multimodal LLM**, and serving it all through a Databricks App.

```
Raw inputs            Ingestion           Object detection        Event analysis         Event Explorer
camera + 22      →   Impulse silver   →   detection + depth   →   rule-based events  →   map · clips · stats
bus signals          channels + frames    perception channels     + GenAI verification    (Databricks App)
```

## The pipeline (run in this order)

| Stage | Notebook / app | What it does | Compute |
|------|----------------|--------------|---------|
| 1. Ingest | [`a2d2_ingestion.ipynb`](./a2d2_ingestion.ipynb) | Downloads each drive's **bus-signals** + **front-camera** tars into a UC Volume; parses the **22 bus channels** into the Impulse silver tables; **untars all camera frames** (index-free, parallel) into per-drive subfolders and records them in `*_camera_frames`. One drive = one **container**, tagged with city + vehicle. | Serverless |
| 2. Detect | [`a2d2_object_detection.ipynb`](./a2d2_object_detection.ipynb) | Runs a torchvision detector (**SSDlite**) + **Depth Anything V2** metric depth on sampled frames; writes **perception channels** (per-class counts, nearest-distance, and center-ahead / in-path variants) — channel ids `100–123`. | Classic **ML** cluster (DBR 17.3 LTS, `r5d`) |
| 3. Analyze | [`a2d2_analysis.ipynb`](./a2d2_analysis.ipynb) | Mines **7 tail-calibrated safety events** (hard braking, pedestrian-in-path, close following, evasive maneuver, …) from the fused bus + perception channels using Impulse event logic; computes **per-event statistics**; exports a short **MP4 clip** per event. | Serverless |
| 4. Verify | [`a2d2_event_verification.ipynb`](./a2d2_event_verification.ipynb) | **VLM-as-judge**: for each event, sends a few camera frames + telemetry to a **multimodal foundation model** with an event-specific rubric; stores a `{is_relevant, confidence, reason}` verdict in `*_event_verification_fact` to flag false positives. | Serverless (inference offloaded to the serving endpoint) |
| 5. Explore | [`app/`](./app) | **Impulse Event Explorer** — a React + FastAPI **Databricks App** (served on a serverless SQL warehouse) showing events on a GPS map with the drive route, video clips, per-event stats, and the AI verdicts; filterable by city / vehicle / event / time and "verified only". | Databricks App + SQL warehouse |

### Outputs (Unity Catalog)
- **Silver** (Impulse model): `*_channels`, `*_channel_tags`, `*_channel_metrics`, `*_container_tags`,
  `*_container_metrics`, `*_camera_frames`. Queryable with **TSAL** exactly like the other Impulse demos.
- **Gold**: `*_event_instance_fact` + `*_event_dimension` (events), `*_stats_aggregator_fact` (per-event
  stats), `*_event_verification_fact` (AI relevance verdicts). MP4 clips land in the volume under
  `/<report_name>/`.

## ⚠️ Dataset license — important

The A2D2 dataset is published by **Audi AG** under the
**Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0)** license:
<https://creativecommons.org/licenses/by-nd/4.0/>. Source: <https://www.a2d2.audi/>.
Dataset paper: Geyer et al., 2020, *A2D2: Audi Autonomous Driving Dataset*, arXiv:2004.06320.

Because the **NoDerivatives** clause forbids distributing the dataset or any derivative of it, **this
repository does not contain or redistribute any A2D2 data**. The notebooks download the data **at
runtime, from the official source, into your own Databricks workspace**, and all parsed tables,
extracted images, clips, and verdicts are written to **your own** Unity Catalog. **Do not commit any
downloaded or derived data** — the local `.gitignore` guards against this, and notebooks must be
committed with their outputs cleared.

## Prerequisites

- A Databricks workspace with **Unity Catalog**, and privilege to create a schema + volume.
- **Serverless** compute (ingestion / analysis / verification) and the ability to launch a **classic
  ML cluster** for detection (the detector + depth model OOM serverless workers).
- A **multimodal serving endpoint** for verification (e.g. `databricks-claude-opus-4-8`,
  `databricks-gemini-3-5-flash`, or any vision-capable Foundation Model endpoint).
- **Internet egress to AWS S3** (`eu-central-1`) to fetch the source tars.
- Volume free space for the **full camera archives** of the drives you ingest (tens to a few hundred
  GB — these download and untar **all** frames, not a sampled subset).
- To build the app: **Node 18+** (`npm`) for the React frontend.

## How to run (Databricks Asset Bundle)

```bash
cd demos/a2d2

# 1) Build the React app (FastAPI serves app/frontend/dist) and deploy the bundle.
( cd app/frontend && npm install && npm run build )
databricks bundle deploy -t dev -p <profile>

# 2) Run the pipeline jobs in order.
databricks bundle run a2d2_ingestion          -t dev -p <profile>   # download + ingest (3 drives)
databricks bundle run a2d2_object_detection    -t dev -p <profile>   # perception channels
databricks bundle run a2d2_analysis            -t dev -p <profile>   # events + stats + MP4 clips
databricks bundle run a2d2_event_verification  -t dev -p <profile>   # GenAI relevance verdicts

# 3) (Re)deploy / restart the app.
databricks bundle run impulse_explorer         -t dev -p <profile>
```

The `impulse` wheel is built from the repo root into `./dist` and installed on the jobs, so
`import impulse_*` works without the repo being on `sys.path`. The `dev` target pins the working
values (catalog, detector model, etc.); override any variable per run with
`--var="catalog=my_cat,frames_per_second=2,…"`.

> **App service principal:** a Databricks App runs as its own service principal. After first deploy,
> grant it `USE CATALOG`/`USE SCHEMA` + `SELECT` on the schema and `READ VOLUME` on the volume so it
> can read the tables and stream clips (the warehouse `CAN_USE` grant comes from the bundle).

### Key bundle variables

| Variable | Default | Used by |
|---|---|---|
| `catalog`, `schema`, `table_prefix`, `volume` | `main` / `a2d2_demo` / `a2d2` / `a2d2_raw` | all |
| `extract_partitions` | `64` | ingestion (parallel untar) |
| `detect_model` / `depth_model` / `estimate_distance` | SSDlite / Depth-Anything-V2 / `true` | detection |
| `frames_per_second` | `1` | detection (temporal subsampling) |
| `ahead_center_frac` | `0.34` | detection (in-path band width) |
| `clip_max_duration_s` / `clip_fps` / `clips_per_event` | `10` / `5` / `5` | analysis (clips) |
| `verify_model` / `frames_per_event` / `verify_window_s` | `databricks-claude-opus-4-8` / `3` / `6` | verification |

The drives to ingest (URLs, city, recording id, `container_id`) are defined as the three ingestion
tasks in [`databricks.yml`](./databricks.yml) — add or edit tasks there to ingest more drives.

## Related

The same TSAL queries, events, and aggregations work against the silver tables this demo produces —
see [`../getting_started.ipynb`](../getting_started.ipynb) and
[`../reporting_pipeline.ipynb`](../reporting_pipeline.ipynb).
