# Vendored Backstop

A copy of the Backstop CLI, so this repository's CI can run the gate without
credentials for the (private) Backstop repository.

Copied, not submoduled, deliberately: a field test should exercise the tool the
way a user would get it, and the "zero runtime dependencies, Node built-ins
only" claim means a plain copy is supposed to work. It will drift from upstream
— that is acceptable here because this repository is a disposable instrument,
not a product.
