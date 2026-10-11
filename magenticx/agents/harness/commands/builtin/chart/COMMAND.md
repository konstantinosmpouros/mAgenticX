---
name: chart
description: Make a chart from data
kind: prompt
argument-hint: "[what to chart]"
requires: [deep_agent]
---
Draw the chart the user asks for below with the `render_chart` tool, using data from the conversation or its files. Pick the chart type that fits the data, label the axes and series, and add one or two sentences on what the chart shows. If the data is missing, ask for it rather than inventing numbers.
