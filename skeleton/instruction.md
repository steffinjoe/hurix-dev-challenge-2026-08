# Firmware Release Publisher
## Overview
This application processes firmware build manifest data and signs the build artifacts using current certificate.

The application workflow is as follows:

- Step 1: The build manifest file is read and contents are created into build_manifest duckDB table. An additional empty table
- published_builds is created to store the published build manifests.
- Step 2: The build_manifest table is read and conditions are applied to filter out WITHDRAWN, SUPERSEDED and FAILED bundles
- Step 3: Using the current certificate, the descriptor data is signed
- Step 4: The descriptor is then verified with the help of publisher API
- Step 5: After verification the bundle information is stored in published_builds table and logged as output in the file report/publications.txt

## KEY RESOURCES
The current key and certificate is available in /app/keys/current folder
The build_manifest file is available in /app/fixures/build_manifest.csv

## PRE-REQUISITES
The APIs to get the current signing key /v1/signing-key/current and verify publication /v1/publications are in the distribution=gateway folder.
The node server should be running prior to the release-publisher script
The server can be run using the command:
```cd /app/distribution-gateway```
```npm run start```
The report is generated using the command:
```cd /app```
```npm run report```
