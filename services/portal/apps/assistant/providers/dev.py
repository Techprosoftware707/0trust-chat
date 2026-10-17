"""The deterministic development provider: no AI model, no network, no invented content.

It recognises a fixed set of requests (the intents of the product brief), asks for the
matching tools, and answers with a fixed sentence: the facts the person sees come from the
tool results themselves ("Verified facts from records"). Anything it doesn't recognise gets
an honest list of what it can do. Every answer is labelled "Development mode: no AI model
connected".
"""

from __future__ import annotations

import datetime as dt
import json
import re
from itertools import count

from django.utils import timezone

from . import Message, ProviderReply, ToolCall, ToolSpec

LABEL = "Development mode: no AI model connected"
_ids = count(1)

HELP = (
    "In development mode I can only run these requests against your records (there is no AI model to understand anything else):\n"
    "• “Summarise <contact name>” or, on a contact, “Summarise this contact”\n"
    "• “Prepare me for my next meeting”\n"
    "• “What are my tasks?” (also “overdue tasks”, “tasks due today”)\n"
    "• “Team's outstanding tasks”\n"
    "• “Upcoming appointments”\n"
    "• “Overdue follow-ups”\n"
    "• “Leads not contacted in 14 days”\n"
    "• “Pipeline overview”\n"
    "• “Daily summary” or “Weekly summary”\n"
    "• “Find contact <name>” / “Search notes for <words>”\n"
    "• “Remind me to <something> tomorrow” or “Add a note: <text>” (prepared for your confirmation)\n"
    "• Real estate and lending: “Approaching deadlines”, “Deals waiting on documents”, “Applications missing documents”, "
    "“Properties matching this client”, “Draft a viewing confirmation”, “Last meeting's action items”"
)

_FILLER = {"summarise", "summarize", "summary", "of", "about", "contact", "the", "please", "tell", "me", "who", "is", "a", "an",
           "find", "search", "look", "up", "for", "show", "brief", "on", "give", "can", "you", "what", "do", "we", "know", "this"}


def _context(system: str) -> dict:
    m = re.search(r"^Context \(JSON\): (\{.*\})$", system, re.M)
    if not m:
        return {}
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _days(q: str, default: int) -> int:
    m = re.search(r"(\d{1,3})\s*(day|days|d\b|week|weeks|w\b)", q)
    if not m:
        return default
    n = int(m.group(1)) * (7 if m.group(2).startswith("w") else 1)
    return max(1, min(n, 365))


def intent(q: str, ctx: dict) -> str:
    q = q.lower()
    has = lambda *words: any(w in q for w in words)  # noqa: E731
    if has("remind me to", "create a task", "add a task", "new task", "make a task"):
        return "create_task"
    if has("add a note", "note:", "save a note", "log a note"):
        return "create_note"
    if has("next meeting", "prepare me", "prep me", "next appointment"):
        return "next_meeting"
    if has("waiting on document", "missing document", "document checklist", "outstanding document", "missing docs"):
        return "documents"
    if has("deadline", "closing date", "contingenc"):
        return "deadlines"
    if has("viewing confirmation", "confirm the viewing", "confirm my viewing") or (has("draft") and has("viewing")):
        return "viewing_draft"
    if has("last meeting", "previous meeting", "action items", "next steps from"):
        return "last_meeting"
    if has("matching propert", "properties for this", "properties that fit", "properties match"):
        return "matching_properties"
    if has("find propert", "search propert", "listings", "properties in"):
        return "search_properties"
    if has("lending report", "lending pipeline", "loan pipeline"):
        return "lending_report"
    if has("team week", "team's week", "week report"):
        return "team_week"
    if has("weekly", "this week", "last week") and has("summary", "recap", "report", "activity"):
        return "weekly"
    if has("daily", "today", "yesterday") and has("summary", "recap", "report", "activity"):
        return "daily"
    if has("pipeline", "forecast", "deals overview", "deal overview"):
        return "pipeline"
    if has("team") and has("task", "to-do", "todo"):
        return "team_tasks"
    if has("my task", "tasks", "to-do", "todo", "what should i do", "my day"):
        return "my_tasks"
    if has("follow-up", "follow up", "followup"):
        return "followups"
    if has("lead") and has("not contacted", "haven't", "have not", "no contact", "since", "stale", "untouched", "without"):
        return "stale_leads"
    if has("summar", "brief me", "what do we know") and (ctx.get("contact_id") or "contact" in q or len(q.split()) <= 6):
        return "contact_summary"
    if has("appointment", "meeting", "calendar", "schedule"):
        return "appointments"
    if has("search notes", "search the timeline", "search activities", "notes about", "emails about", "timeline for"):
        return "search_activities"
    if has("find", "search", "look up", "lookup") or ctx.get("contact_id") and has("contact"):
        return "search_contacts"
    return "help"


def _name_query(q: str) -> str:
    words = [w for w in re.findall(r"[\w@.+'-]+", q) if w.lower() not in _FILLER]
    return " ".join(words)[:100]


def _task_title(q: str) -> tuple[str, dt.datetime | None]:
    text = q.strip().rstrip(".!?")
    m = re.search(r"(?:remind me to|create a task(?: to)?|add a task(?: to)?|new task(?: to)?|make a task(?: to)?)[:\s]*(.+)", text, re.I)
    title = (m.group(1) if m else text).strip()
    due = None
    now = timezone.now()
    morning = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if re.search(r"\btomorrow\b", title, re.I):
        due = morning + dt.timedelta(days=1)
        title = re.sub(r"\s*\btomorrow\b", "", title, flags=re.I)
    elif re.search(r"\btoday\b", title, re.I):
        due = max(now + dt.timedelta(hours=1), morning)
        title = re.sub(r"\s*\btoday\b", "", title, flags=re.I)
    else:
        m2 = re.search(r"\s*\bin (\d{1,2}) days?\b", title, re.I)
        if m2:
            due = morning + dt.timedelta(days=int(m2.group(1)))
            title = title[: m2.start()] + title[m2.end():]
    title = title.strip(" :,-") or "Follow up"
    return title[:1].upper() + title[1:200], due


def _note_text(q: str) -> str:
    m = re.search(r"(?:add a note|note|save a note|log a note)\s*:?\s*(.+)", q, re.I | re.S)
    return (m.group(1) if m else q).strip()


def _call(name: str, args: dict) -> ToolCall:
    return ToolCall(id=f"dev_{next(_ids)}", name=name, arguments=args)


def _results_since_user(messages: list[Message]) -> list[tuple[str, dict, bool]]:
    out: list[tuple[str, dict, bool]] = []
    for msg in reversed(messages):
        if msg.role == "user":
            break
        if msg.role == "tool":
            for r in msg.results:
                try:
                    data = json.loads(r.content)
                except ValueError:
                    data = {}
                out.append((r.name, data if isinstance(data, dict) else {}, r.is_error))
    out.reverse()
    return out


class DevProvider:
    name = "dev"
    label = LABEL
    model = ""
    is_model = False

    def problem(self) -> str:
        return ""

    def complete(self, *, system: str, messages: list[Message], tools: list[ToolSpec]) -> ProviderReply:
        available = {t.name for t in tools}
        ctx = _context(system)
        question = next((m.text for m in reversed(messages) if m.role == "user"), "")
        done = _results_since_user(messages)
        kind = intent(question, ctx)
        step = self._next(kind, question, ctx, done, available)
        if isinstance(step, list):
            return ProviderReply(text="", tool_calls=step, stop="tool_use")
        return ProviderReply(text=f"{LABEL}. {step}", stop="end")

    # Returns a list of tool calls to make next, or the final sentence.
    def _next(self, kind: str, q: str, ctx: dict, done: list, available: set[str]):
        def want(name: str, args: dict):
            return [_call(name, args)] if name in available else (
                "That information isn't available in this workspace (the feature is turned off or not part of this build).")

        errors = [d for _, d, err in done if err]
        if errors:
            msg = errors[-1].get("error", {}).get("message") or "The request could not be completed."
            return f"The records couldn't be read: {msg}"
        last = done[-1] if done else None
        found = "These are the records for your request; there is no AI-written summary in this mode."

        if kind == "contact_summary":
            if not done:
                if ctx.get("contact_id"):
                    return want("get_contact_summary", {"contact_id": ctx["contact_id"]})
                query = _name_query(q)
                if not query:
                    return "Which contact? Open a contact and ask again, or write “Summarise <name>”."
                return want("search_contacts", {"query": query, "limit": 5})
            if last[0] == "search_contacts":
                rows = last[1].get("contacts", [])
                if len(rows) == 1:
                    return want("get_contact_summary", {"contact_id": rows[0]["id"]})
                if not rows:
                    return "No contact you can see matches that name."
                return "Several contacts match; open the one you mean and ask again, or use a more specific name."
            return found
        if kind == "next_meeting":
            if not done:
                args = {"days": 30, "scope": "mine", "limit": 1}
                if ctx.get("contact_id"):
                    args["contact_id"] = ctx["contact_id"]
                return want("upcoming_appointments", args)
            if last[0] == "upcoming_appointments":
                events = last[1].get("events", [])
                if not events:
                    return "You have no meeting scheduled in the next 30 days."
                ev = events[0]
                if ev.get("contact"):
                    return want("get_contact_summary", {"contact_id": ev["contact"]["id"]})
                if ev.get("opportunity"):
                    return want("get_opportunity", {"opportunity_id": ev["opportunity"]["id"]})
                return "Here is your next meeting. It isn't linked to a contact or deal, so there is nothing more to prepare from."
            if last[0] == "get_contact_summary" and "meeting_action_items" in available:
                return [_call("meeting_action_items", {"contact_id": last[1]["contact"]["id"]})]
            return "Here is your next meeting and what the records say about who you're meeting."
        if kind == "viewing_draft":
            if not done:
                args = {"upcoming_only": True, "limit": 1}
                if ctx.get("contact_id"):
                    args["contact_id"] = ctx["contact_id"]
                return want("viewings", args)
            if last[0] == "viewings":
                rows = last[1].get("viewings", [])
                if not rows:
                    return "There is no upcoming viewing to confirm."
                return want("draft_viewing_confirmation", {"event_id": rows[0]["id"]})
            return "Here is a draft built from the appointment. It hasn't been sent: copy it and send it yourself."
        if done:
            if last[0].startswith("prepare_"):
                return "I prepared this change. Review it below and press Confirm to apply it, or Cancel."
            return found

        single = {
            "my_tasks": ("list_my_tasks", {"view": "overdue" if "overdue" in q.lower() else "today" if "today" in q.lower() else "open"}),
            "team_tasks": ("team_outstanding_tasks", {"overdue_only": "overdue" in q.lower()}),
            "appointments": ("upcoming_appointments", {"days": _days(q.lower(), 7), "scope": "team" if "team" in q.lower() else "mine"}),
            "followups": ("overdue_followups", {"scope": "team" if "team" in q.lower() else "mine"}),
            "stale_leads": ("leads_not_contacted_since", {"days": _days(q.lower(), 14), "scope": "team" if "team" in q.lower() else "mine"}),
            "pipeline": ("pipeline_overview", {}),
            "weekly": ("weekly_activity_summary", {"scope": "team" if "team" in q.lower() else "mine"}),
            "daily": ("daily_activity_summary", {"scope": "team" if "team" in q.lower() else "mine"}),
        }
        if kind in single:
            name, args = single[kind]
            return want(name, args)
        if kind == "documents":
            order = ("lending_applications_missing_documents", "deals_waiting_on_documents") if "application" in q.lower() else (
                "deals_waiting_on_documents", "lending_applications_missing_documents")
            for name in order:
                if name in available:
                    return [_call(name, {})]
            return "Lending document checklists aren't turned on for this workspace, so there's nothing to list."
        if kind == "deadlines":
            return want("approaching_deadlines", {"days": _days(q.lower(), 14)})
        if kind == "last_meeting":
            return want("meeting_action_items", {"contact_id": ctx["contact_id"]} if ctx.get("contact_id") else {})
        if kind == "matching_properties":
            if not ctx.get("contact_id"):
                return "Open the client's contact and ask again, so I know whose preferences to use."
            return want("matching_properties", {"contact_id": ctx["contact_id"]})
        if kind == "search_properties":
            query = re.sub(r"(?i)^.*?(find properties|search properties|properties in|listings)\s*(in|for|on)?\s*", "", q).strip(" ?.")
            return want("search_properties", {"query": query[:100]})
        if kind == "lending_report":
            return want("lending_pipeline_report", {})
        if kind == "team_week":
            return want("team_week_report", {})
        if kind == "search_activities":
            query = re.sub(r"(?i)^.*?(notes about|emails about|timeline for|search notes for|search notes|search the timeline for|"
                           r"search the timeline|search activities for|search activities)\s*", "", q).strip(" ?.")
            args = {"query": query[:100]}
            if ctx.get("contact_id"):
                args["contact_id"] = ctx["contact_id"]
            return want("search_activities", args)
        if kind == "search_contacts":
            query = _name_query(q)
            if not query:
                return "Who are you looking for? Write “Find contact <name>”."
            return want("search_contacts", {"query": query, "limit": 10})
        if kind == "create_task":
            title, due = _task_title(q)
            args = {"title": title}
            if due:
                args["due_at"] = due.isoformat().replace("+00:00", "Z")
            if ctx.get("contact_id"):
                args["contact_id"] = ctx["contact_id"]
            elif ctx.get("opportunity_id"):
                args["opportunity_id"] = ctx["opportunity_id"]
            return want("prepare_create_task", args)
        if kind == "create_note":
            text = _note_text(q)
            target = {"contact_id": ctx["contact_id"]} if ctx.get("contact_id") else (
                {"opportunity_id": ctx["opportunity_id"]} if ctx.get("opportunity_id") else None)
            if not target:
                return "Open the contact or deal the note belongs to, then ask again."
            if not text:
                return "What should the note say? Write “Add a note: <text>”."
            summary = text.splitlines()[0][:300]
            return want("prepare_create_note", {"summary": summary, "body": text if len(text) > len(summary) else "", **target})
        return HELP
