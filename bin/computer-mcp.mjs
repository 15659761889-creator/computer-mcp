#!/usr/bin/env node
// The pre-rename entry file. A launcher.vbs loop or systemd unit started before
// the rename keeps running this path until the next logon, even after `update`
// rewrites the launcher, so it must keep starting the service.
import './wanji.mjs';
