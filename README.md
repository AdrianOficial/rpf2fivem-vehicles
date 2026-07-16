# rpf2fivem-vehicles

My personal toolbox for converting GTA V vehicle DLCs (`dlc.rpf`) into working **FiveM** resources, and for fixing everything that usually breaks along the way (duplicate carcols IDs, missing shared vehshare textures, merging dozens of cars into a single resource).

I built these scripts to make my life easier — instead of clicking through OpenIV/CodeWalker for every single car, everything here runs from the command line with plain Node.js / Python / PowerShell.

> Requirements: [Node.js](https://nodejs.org) 16+ for the `.js` tools, Python 3.9+ for the merger, and CodeWalker (only for the optional PowerShell texture merger).

---

## The pipeline (how I use it)

```
dlc.rpf (vehicle DLC)
   │
   ├─ 1. convert-dlc-rpf-fixed.js   → extracts the RPF and builds a FiveM resource (data/ + stream/ + fxmanifest.lua)
   ├─ 2. carcols_fixer.js           → fixes duplicate siren / light / modkit IDs across all resources
   ├─ 3. fix-vehshare-textures.js   → puts the missing shared vehshare textures back into each car's YTD
   │      └─ (optional) cw-merge-textures.ps1 → same thing but done 100% through CodeWalker.Core.dll
   └─ 4. merge_vehicle_resources.py → merges all the converted cars into one single resource
```

---

## Scripts

### `convert-dlc-rpf.js` — DLC → FiveM resource converter

A **native RPF7 extractor written in pure Node.js** (no OpenIV needed). It reads the binary RPF archive format directly: parses the entry table, resolves the name table, walks the directory tree, inflates the deflate-compressed payloads and recurses into nested `.rpf` archives.

After extraction it builds a ready-to-use FiveM resource:

- known metadata files (`vehicles.meta`, `handling.meta`, `carcols.meta`, `carvariations.meta`, `vehiclelayouts.meta`, `dlctext.meta`, …) go into `data/` and get the correct `data_file` type in the manifest
- streamable assets (`.yft`, `.ytd`, `.ydr`, `.ydd`, `.ymap`, `.awc`, …) go into `stream/` (with automatic renaming when two files collide)
- an `fxmanifest.lua` is generated for you

```bash
node convert-dlc-rpf.js --input dlc.rpf --output mycar_fivem   # single car
node convert-dlc-rpf.js --batch ./mods --output ./converted    # every dlc.rpf found in a folder
node convert-dlc-rpf.js --input dlc.rpf --list                 # just list the archive contents
node convert-dlc-rpf.js --source-dir extracted_dlc -o out      # use a folder already extracted with OpenIV
```

Encrypted / non-standard RPFs are detected and reported — extract those once with OpenIV/CodeWalker and re-run with `--source-dir`.

### `convert-dlc-rpf-fixed.js` — improved converter

Same tool as above with the fixes I needed in practice:

- **skips encrypted language archives** (`data/lang/*.rpf`) instead of failing the whole conversion — those language RPFs are often encrypted and irrelevant for a vehicle
- supports more streamable extensions (`.ycd` animation clips, `.ybn` collision bounds, `.ytyp`)

This is the one I actually run day to day.

### `carcols_fixer.js` — carcols ID overlap patcher

When you install many vehicle packs, their `carcols.meta` files inevitably reuse the same IDs, which breaks sirens, lights and tuning kits server-wide. This CLI scans **all** resources and repairs the collisions:

- walks every `carcols.meta` / `carvariations.meta` under `./resources`
- finds duplicated `sirenSettings` (1–254), `lightSettings` (1–255) and `modKit` (1–65535) IDs
- reassigns conflicting IDs to free slots and rewrites **both** the carcols entry and every `carvariations.meta` reference (including `<kitName>` like `950_mycar_modkit`)
- auto-repairs *dangling* kit bindings (a carvariations entry pointing to a kit name that no longer exists)
- writes `.bak` backups next to every touched file, with a one-command rollback
- validates every edit (no overlaps, sane ranges) before writing anything, so it can never corrupt a meta file
- supports the **SirenSetting Limit Adjuster** client mod (`--ssla`) which raises the siren cap from 254 to 65534

```bash
node carcols_fixer.js scan            # report only, no writes
node carcols_fixer.js fix             # scan + patch + .bak backups
node carcols_fixer.js revert          # restore everything from .bak
node carcols_fixer.js list            # show every meta file it found
node carcols_fixer.js fix --dry --json  # machine-readable plan without writing
```

Optional `config.json` next to the script lets you toggle pools, ignore folders, default to dry-run, etc.

### `fix-vehshare-textures.js` — missing vehshare texture injector

FiveM no longer allows streaming `vehshare.ytd`, so converted cars lose all the shared textures they reference and show up untextured. This tool fixes that **entirely in Node.js**, working directly with the binary formats:

1. opens the `./vehshare/**/dlc.rpf` archives and builds a texture library (name → texture) from every `.ytd` inside, respecting the game's lookup order (`vehshare` first, then the other shared dictionaries)
2. decompresses each resource's geometry (`.yft`/`.ydr`/`.ydd` RSC7 containers) and extracts the texture names it references
3. compares against what the car's own `.ytd` already contains
4. injects the missing textures straight into the vehicle's YTD — parsing and **rebuilding the RSC7/YTD binary structure** (system/graphics segments, page flags, JOAAT-hash-sorted texture dictionary), creating the YTD if it doesn't exist, and keeping backups of the originals

```bash
node fix-vehshare-textures.js --dry-run             # report what's missing, change nothing
node fix-vehshare-textures.js                       # inject (backups in backup_vehshare_fix/)
node fix-vehshare-textures.js --resource mycar      # single resource only
node fix-vehshare-textures.js --exclude "plate"     # skip textures matching a regex
node fix-vehshare-textures.js --manifest vehshare_cw_manifest.json   # don't touch YTDs, write a plan for cw-merge-textures.ps1
```

Every run also writes a full log to `vehshare_fix_report.txt`.

### `fix-vehshare-textures-safe-v3.js` — safer injector variant

Same idea, but with a more conservative YTD writer for the YTDs that the full rebuild didn't like:

- **preserves the original file layout byte-for-byte** — existing texture structs and graphics data stay exactly where they were; new textures and the updated dictionary tables are appended at the end
- uses a simpler, unambiguous RSC7 page encoding (one largest-class page per segment) that every loader decodes the same way

### `cw-merge-textures.ps1` — CodeWalker-powered texture merger

The "let CodeWalker do the binary work" alternative. It consumes the manifest produced by `fix-vehshare-textures.js --manifest` and performs the merge by driving **`CodeWalker.Core.dll` directly** (load YTD → merge texture lists → save), so the output files are produced 100% by CodeWalker's own writer.

```powershell
node fix-vehshare-textures.js --manifest vehshare_cw_manifest.json
powershell -File cw-merge-textures.ps1 -Manifest vehshare_cw_manifest.json -DeployDir "D:\server\resources\cars\stream"
```

`-DeployDir` optionally copies each rebuilt YTD straight into the server's stream folder. Adjust `-CodeWalkerDll` to wherever your CodeWalker install lives.

### `merge_vehicle_resources.py` — resource merger

Running 100 cars as 100 separate resources is slow to start and messy to manage. This script merges every vehicle resource in a folder into **one** resource:

- auto-detects vehicle resources (must have an `fxmanifest.lua`/`__resource.lua` plus `data/` or `stream/`)
- merges the XML metadata properly per file type: `vehicles.meta` (InitDatas + txdRelationships), `handling.meta`, `carcols.meta`, `carvariations.meta`, `vehiclelayouts.meta`, and generates a fresh `dlctext.meta`
- validates every meta file first (XML well-formedness + expected root element) and refuses to build if anything is broken
- copies all `stream/` files, detecting real conflicts (same filename, different content) instead of silently overwriting
- writes the merged `fxmanifest.lua` and a `MERGED_SOURCES.txt` report of what went in

```bash
python merge_vehicle_resources.py --output merged_vehicles          # merge everything in the current folder
python merge_vehicle_resources.py --dry-run                        # validate + summary only
python merge_vehicle_resources.py --base ./converted --output all_cars --force
```

---

## Data files

| Path | What it is |
|---|---|
| `vehshare/base_cars/dlc.rpf` | DLC archive with the extra shared texture dictionaries |
| `vehshare/vehshare_main/dlc.rpf` | DLC archive with the shared `vehshare` textures |

The tools also generate local files that are not tracked in git: `vehshare_cw_manifest.json` (the plan consumed by `cw-merge-textures.ps1`) and `vehshare_fix_report.txt` (log of the last `fix-vehshare-textures` run).

---

## Notes

- Everything is read-only by default where it matters: the fixers have `--dry-run` / `scan` modes and keep backups before writing.
- The RPF/RSC7/YTD readers only support standard **unencrypted** archives; anything encrypted has to go through OpenIV/CodeWalker once.
- This is a personal project — it fits *my* workflow for GTA V → FiveM vehicle conversions. Use at your own risk, and always keep backups of your server files.
