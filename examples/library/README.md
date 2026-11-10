# Library example

This fixture runs with Bun and `tar` (available on macOS and Linux). From this directory, open the cockpit:

```sh
bun ../../bin/cli.js
```

Press `1` and confirm Release to run the library tests, package `package.json` and `library.js` into `out/library.tgz`, and write `out/library.tgz.sha256`. The test output is saved as `out/test.txt`.

Press `P` and confirm validation. Once it passes, press `P` again and confirm the copy to `out/published/`. This is the example's local publish destination. The copy step checks the archive and checksum again before writing files.

For a simulation that creates no files, use `bun ../../bin/cli.js --demo`. Individual backend commands are also available as `./release.sh test`, `pack`, `checksum`, `validate`, and `upload`.
