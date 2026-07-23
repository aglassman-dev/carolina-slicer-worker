# Third-Party Notices

## Bambu Studio and OrcaSlicer

This repository does not bundle either slicer. Operators install and invoke a separate copy.

- Bambu Studio: <https://github.com/bambulab/BambuStudio>
- OrcaSlicer: <https://github.com/OrcaSlicer/OrcaSlicer>

Both projects identify their slicer software as GNU Affero General Public License v3.0. Operators are responsible for preserving notices, providing corresponding source where required, and reviewing any separately licensed networking components.

The worker container downloads the official Bambu Studio `v02.07.01.62` Ubuntu 22.04 AppImage from the project release and verifies SHA-256 `2749917af560f3b9a2681429da9c43d00c65d096e1a1c479cc49466634174549` before extracting it. Bambu Studio remains separately licensed under AGPL-3.0; its corresponding source is available from the linked upstream repository and release tag.

## OpenCascade and occt-import-js

STEP/STP conversion uses `occt-import-js` 0.0.23, distributed under LGPL-2.1 and embedding Open CASCADE Technology. Preserve the license files included with that dependency.

- `occt-import-js`: <https://github.com/kovacsv/occt-import-js>
- Open CASCADE licensing: <https://dev.opencascade.org/resources/licensing>

## JavaScript dependencies

The package also uses `adm-zip` and `zod`. Their license texts are distributed with their packages by the package manager.
