---
name: okie-package
description: Package an existing Okie scan artifact with the static viewer for local viewing or self-hosting, without publishing it. Use when a user wants to open or share a portable atlas.
---

# Package a portable atlas

Use an existing `atlas.okie.json`. The `sourcefor-atlas` CLI (`@sourcefor/atlas`) bundles a matching prebuilt viewer, so `export` needs no viewer argument:

```sh
sourcefor-atlas export --bundle <atlas.okie.json> --out <empty-site-directory>
```

To use another viewer build, add `--viewer <built-viewer>`: a directory containing `index.html` and relative assets, such as `apps/web/dist-portable` from `pnpm build:portable` in an Okie source checkout. Running the CLI from source (not the package) has no bundled viewer and requires `--viewer`.

The command validates the artifact and requires an empty output directory outside the viewer directory. Serve that folder over static HTTP, for example with `python3 -m http.server 4175 --directory <site-directory>`. Direct `file://` opening is not supported by this workflow.

Open the resulting page and verify that the packaged atlas loads, a selected node has source evidence, and the dedicated source tab returns to the map. No application backend is needed. Browser-local Open scan, replacement and optional IndexedDB storage operate on one repository artifact at a time. Forgetting browser storage does not delete the exported file or the copy packaged with the site.

For a reusable empty viewer, omit `atlas.okie.json` from the exported folder; keep its portable marker and assets. Verify that the page opens the file picker/drop zone. A previously remembered scan can still load on that browser; use Forget to return to the picker.

Report the folder and serving URL. The artifact can contain source excerpts and optional full source, so describe what this particular bundle includes before sharing. Publish or upload only when the user asks for that destination; preparing a local package does not authorize deployment.
