# Large assets (not in git)

Large models and their sources are kept on external storage, not in git. Download them by hand into this folder and keep the same layout as in `assets/`, grouped by source:

```
assets/external/<source>/<name>.{blend,glb,fbx,obj,jpg,…}
```

Storage location: _to be filled in (link / path)_

Everything here except this README is git-ignored. Small assets stay committed in `assets/<source>/`.

**Rule of thumb:** files over about 20 MB go here.
