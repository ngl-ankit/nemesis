"""Nemesis — AI voice debate assistant. Flask entry point."""

from flask import Flask, jsonify, render_template, request

import database
from llm_client import counter_argument, detect_fallacy, scorecard

app = Flask(__name__)
database.init_db()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/debate", methods=["POST"])
def debate():
    body = request.get_json(force=True) or {}
    opinion = body.get("opinion", "")
    persona = body.get("persona", "ultron")
    # history is a list of [role, text] pairs; keep only the last 6.
    history = body.get("history", [])[-6:]
    counter = counter_argument(opinion, persona, history)
    return jsonify({"counter_argument": counter})


@app.route("/api/fallacy", methods=["POST"])
def fallacy():
    body = request.get_json(force=True) or {}
    statement = body.get("statement", "")
    return jsonify(detect_fallacy(statement))


@app.route("/api/scorecard", methods=["POST"])
def scorecard_endpoint():
    body = request.get_json(force=True) or {}
    transcript = body.get("transcript", "")
    return jsonify(scorecard(transcript))


@app.route("/api/session/save", methods=["POST"])
def session_save():
    body = request.get_json(force=True) or {}
    database.save_session(
        topic=body.get("topic", ""),
        transcript=body.get("transcript", []),
        fallacies=body.get("fallacies", []),
        score_you=int(body.get("score_you", 0) or 0),
        score_nemesis=int(body.get("score_nemesis", 0) or 0),
        scorecard_text=body.get("scorecard_text", ""),
    )
    return jsonify({"ok": True})


@app.route("/api/session/history", methods=["GET"])
def session_history():
    return jsonify({"sessions": database.get_sessions()})


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)