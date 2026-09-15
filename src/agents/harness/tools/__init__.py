"""Platform-owned agent tools.

Layout: one folder per tool (``<name>/tool.py`` + a barrel), with the two
cross-cutting modules at this level — ``builtins.py`` (the prebuilt roster and
its approval defaults) and ``registry.py`` (which native tool is built for a
run, and how). A tool folder is the unit that grows: ``view_image`` already
carries crop logic beside its builder, and splitting it does not move the
import path.

Nothing is re-exported here on purpose — importing this package must not drag
in every tool's dependencies. Import the tool you need:
``from harness.tools.charts import build_render_chart_tool``.
"""
