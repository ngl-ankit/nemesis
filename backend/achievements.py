"""Rule-based achievement definitions and evaluation."""

from __future__ import annotations

ACHIEVEMENTS = {
    "first_blood": {"name": "First Blood", "desc": "Complete your first debate.", "icon": "01"},
    "fallacy_free": {"name": "Fallacy-Free Round", "desc": "Finish a debate with zero fallacies detected.", "icon": "00"},
    "steelman_slayer": {"name": "Steelman Slayer", "desc": "Beat Nemesis on Mythic difficulty.", "icon": "SS"},
    "comeback_win": {"name": "Comeback Win", "desc": "Win after your opening point was rated below 40.", "icon": "CB"},
    "marathon": {"name": "Marathon", "desc": "Hold a debate for 8+ of your own turns.", "icon": "MR"},
    "decisive": {"name": "Decisive Victory", "desc": "Score 70 or higher in a single debate.", "icon": "70"},
    "polyglot": {"name": "Polyglot", "desc": "Debate in a language other than English.", "icon": "PL"},
    "hat_trick": {"name": "Hat Trick", "desc": "Win three debates in a row.", "icon": "x3"},
    "veteran": {"name": "Veteran", "desc": "Complete ten debates.", "icon": "10"},
    "persona_tour": {"name": "Persona Tour", "desc": "Debate every persona at least once.", "icon": "PT"},
}


def evaluate(session: dict, stats: dict) -> list[str]:
    """Return achievement keys earned by ``session`` given post-save ``stats``."""
    earned: list[str] = []
    won = session["score_you"] > session["score_nemesis"]
    user_turns = len([m for m in session.get("transcript", []) if m.get("role") == "user"])
    strengths = [s for s in session.get("strengths", []) if isinstance(s, (int, float))]

    if stats.get("total_debates", 0) >= 1:
        earned.append("first_blood")
    if user_turns >= 2 and not session.get("fallacies"):
        earned.append("fallacy_free")
    if won and session.get("difficulty") == "mythic":
        earned.append("steelman_slayer")
    if won and strengths and strengths[0] < 40:
        earned.append("comeback_win")
    if user_turns >= 8:
        earned.append("marathon")
    if session["score_you"] >= 70:
        earned.append("decisive")
    if (session.get("language") or "en").split("-")[0] != "en":
        earned.append("polyglot")
    if stats.get("current_streak", 0) >= 3:
        earned.append("hat_trick")
    if stats.get("total_debates", 0) >= 10:
        earned.append("veteran")
    if len(stats.get("persona_counts", {})) >= 4:
        earned.append("persona_tour")
    return earned
