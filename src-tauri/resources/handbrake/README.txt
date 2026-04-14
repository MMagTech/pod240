Place HandBrakeCLI here for a self-contained install (same folder as this README).

Release builds and `npm run vendor:release` use `scripts/third-party.json` on Windows:
URLs for the FT129 zips plus SHA-256 of each zip file so downloads are verified (Explorer dates on .exe/.dll reflect the files inside the archives, not whether they match GitHub).

Windows: HandBrakeCLI.exe plus all DLLs from your HandBrake install (e.g. hb.dll).
macOS: HandBrakeCLI binary and required frameworks/dylibs from the HandBrake.app bundle.

The Olsro 240p30 preset expects:
- Windows: FDK-AAC capable build (see Olsro iPod guide).
- macOS: standard HandBrake with Core Audio AAC.

Alternatively set environment variable POD240_HANDBRAKE_CLI to the full path of HandBrakeCLI.

HandBrake is GPLv2: https://handbrake.fr/
