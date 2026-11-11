"""Out-of-process add-ons: the Facet side of the boundary (docs/CONFIGURATION.md, Add-ons).

Each concern sits in its own module behind a small interface, so one can be swapped or dropped
without touching the others:

* :mod:`api.addons.manifest` -- discovery and validation of ``<facet data>/addons/<id>/addon.json``.
* :mod:`api.addons.auth` -- the add-on token verifier and ``ADDON_ROUTE_SCOPES`` (default deny).
"""
