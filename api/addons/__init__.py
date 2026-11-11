"""Out-of-process add-ons: the Facet side of the boundary (docs/CONFIGURATION.md, Add-ons).

Each concern sits in its own module behind a small interface, so one can be swapped or dropped
without touching the others:

* :mod:`api.addons.manifest` -- discovery and validation of ``<facet data>/addons/<id>/addon.json``.
* :mod:`api.addons.auth` -- the add-on token: ``ADDON_PERMISSION_TOOLS`` (its MCP tool allowlist) and the
  few ``/api`` reads it keeps (default deny).
* :mod:`api.addons.panels` -- per-open nonces and validated sidebar scopes.
* :mod:`api.addons.proxy` -- the ``/addons/{id}/{path}`` reverse proxy for the sandboxed sidebar.
* :mod:`api.addons.runs` -- the ``addon_runs`` side table and the ``scan_run`` photo scope.
* :mod:`api.addons.supervisor` -- starting and stopping supervised add-on processes
  (:mod:`api.addons.winjob`, fork-only: the Windows job object that ends the whole process tree).
"""
