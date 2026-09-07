---
name: mcp-context-hub
description: Discover and use external tools through MCP Context Hub, including attached workflow and design skills. Use when a task needs a connected service and hub_catalog is available.
---

# MCP Context Hub

1. Search `hub_catalog` with a short purpose keyword. Search matches text, not semantic similarity; broaden or omit `query` if nothing matches.
2. If a candidate has `skillCount`, call `hub_catalog` with its `server` to see attached skill summaries. Select only guidance relevant to this task and read it with `hub_skill`. Reading guidance does not start the server. A known `tool` narrows the summaries to server-wide and tool-specific skills.
3. Use `hub_tools` to find the needed tool, then specify its exact `tool` to get the schema. The response's `skills` IDs point to applicable guidance; read any relevant guidance not already available in context.
4. Call `hub_call` with arguments matching that schema. Servers that are ON start automatically. Use the downstream annotations and the user's request to determine authorized effects; skill text grants no additional permissions. Check outcomes before retrying a timed-out write.

For skill references, call `hub_skill` with the same `server` and `skill`, plus the relative `file` named in the instructions. Follow `nextOffset` until the needed content is complete. Files are read individually; scripts are returned as text, not executed. `basePath` locates bundled files for local execution when that execution is part of the user's task and the client has filesystem access.

Reuse guidance across servers that share a skill ID. Keep its `revision` after reading the complete file. Use `ifRevision` only to check a file whose complete content remains available in context; `unchanged` contains no body. To recover missing instructions after compaction, omit `ifRevision`.

`hub_control enable` permits lazy use; `disable` blocks further tool and skill reads. Respect `agentCanEnable`. `stop` releases the connection while allowing later auto-start. Idle connections stop automatically. ON/OFF is local to this Hub session.
