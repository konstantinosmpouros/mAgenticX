"""One module per platform-owned prompt section.

Each exposes a single function taking a ``PromptContext`` and returning either
its section or "" when the feature is off. They are imported by the composer
directly rather than re-exported here — a section is only ever used through the
composer, which owns the order they appear in.
"""
