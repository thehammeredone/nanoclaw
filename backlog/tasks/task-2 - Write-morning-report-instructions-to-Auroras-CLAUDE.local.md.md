---
id: TASK-2
title: Write morning report instructions to Aurora's CLAUDE.local.md
status: To Do
assignee: []
created_date: '2026-06-24 03:47'
labels:
  - content
  - skylight
  - aurora
dependencies:
  - TASK-1
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Write complete per-group instructions for Aurora in groups/skylight-morning/CLAUDE.local.md. Aurora's job is to generate a daily morning briefing using the Skylight MCP tools available in the container. The MCP exposes 17 tools: 11 read tools (list_frames, get_frame, list_chores, list_categories, list_devices, list_lists, get_list, list_source_calendars, list_calendar_events, list_rewards, get_reward_points), 4 guarded write tools (create_chore, create_task_box_item, delete_chore, delete_task_box_item), plus authenticate and health. For the morning report: calendar events (date_min/date_max = today), chores (after = yesterday, before = tomorrow, include_late = true), and reward_points. The report format should be structured: greeting, calendar events section, chores due today section, reward point balances section. Follow the Mjollnir CLAUDE.local.md style (identity intro, behavioral sections, concrete examples in code blocks).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLAUDE.local.md opens with Aurora's identity and purpose as a morning briefing assistant
- [ ] #2 Contains a Morning Report section that defines the report format and data sources
- [ ] #3 Specifies the correct API call sequence: list_calendar_events (date_min=today, date_max=today), list_chores (after=yesterday, before=tomorrow, include_late=true), get_reward_points
- [ ] #4 Includes guidance on handling 401 errors (token expired — user must re-run capture_token_cli.py)
- [ ] #5 Specifies report output format with sections for events, chores, and reward points
- [ ] #6 Includes instructions for how to trigger the report (respond to any message asking for the morning report, daily briefing, or similar)
<!-- AC:END -->
