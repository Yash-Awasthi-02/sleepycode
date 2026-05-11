---
title: "Acknowledged HA Safety Violations"
created: ""
type: domain
tags: [ha-safety, acknowledgement]
automation_ids: []
script_ids: []
---

# Acknowledged HA Safety Violations

Add automation or script IDs to the frontmatter lists above to suppress them from the weekly safety audit.
The `automation_ids` and `script_ids` lists are the authoritative match keys read by `ha audit-automations`
and `ha audit-scripts`. Body bullets below are operator-facing documentation only — add them for traceability.

Bullet format:

  - refs=[automation.<id>] rationale="<why this is acceptable>" acknowledged=<ISO-date>
  - refs=[script.<id>] rationale="<why this is acceptable>" acknowledged=<ISO-date>

To find the id for an automation: `ha_agent_lab ha list-automations` or check the audit output.
To find the id for a script: `ha_agent_lab ha list-scripts`.
