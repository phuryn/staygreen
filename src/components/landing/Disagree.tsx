"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { StateIcon } from "@/components/State";
import { firstCity, secondCity } from "./plan-copy";

// The landing hero's one live thing: the same request, read two ways. A ping only sees the
// status code, so it stays up while the body says the database is gone. It is an example on
// sample data, played in the browser, and it says so: it never claims to have checked or sent
// anything.

type Phase = "up" | "checking" | "confirming" | "down" | "recovering";

export function Disagree() {
  const [phase, setPhase] = useState<Phase>("up");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const at = (ms: number, p: Phase) => timers.current.push(window.setTimeout(() => setPhase(p), ms));
  const broken = phase !== "up" && phase !== "recovering";

  function breakIt() {
    timers.current.forEach(clearTimeout);
    setPhase("checking");
    at(900, "confirming");
    at(2300, "down");
  }
  function fixIt() {
    timers.current.forEach(clearTimeout);
    setPhase("recovering");
    at(1400, "up");
  }

  const sg =
    phase === "up"
      ? { cls: "up", word: "Up", why: <><code className="code">$.db.ok</code> is <code className="code">true</code>, as expected.</> }
      : phase === "checking"
        ? { cls: "busy", word: "Checking", why: `Reading the response from ${secondCity}.` }
        : phase === "confirming"
          ? { cls: "busy", word: "Re-checking", why: <><code className="code">$.db.ok</code> was false. Confirming from {firstCity} before anyone is woken.</> }
          : phase === "down"
            ? { cls: "down", word: "Down", why: <><code className="code">$.db.ok</code> should be <code className="code">true</code>. It came back <code className="code">false</code>.</> }
            : { cls: "busy", word: "Passing again", why: "Two passes in a row close the incident." };

  return (
    <div className={`hx ${phase === "down" ? "is-down" : ""}`} data-ui aria-live="polite">
      <div className="hx-top">
        <span className="hx-req">
          <span className="hx-method">GET</span>
          <span className="hx-url">askone.org/api/health</span>
        </span>
        <span className="hx-code">200 OK in 182 ms</span>
      </div>

      <pre className="hx-body" aria-label="Response body">
        {"{\n"}
        {'  "status": "ok",\n'}
        {'  "db": {\n'}
        <span className={broken ? "hx-line bad" : "hx-line"}>{broken ? '    "ok": false,' : '    "ok": true,'}</span>
        {broken ? '    "error": "too many connections"\n' : '    "latency_ms": 41\n'}
        {"  }\n}"}
      </pre>

      <div className="hx-verdicts">
        <div className="hx-v">
          <span className="hx-who">A ping monitor says</span>
          <span className="hx-state">
            <StateIcon state="up" size={22} />
            Up
          </span>
          <span className="hx-why">The server answered 200. That&rsquo;s all a ping looks at.</span>
        </div>
        <div className={`hx-v hx-sg ${sg.cls}`}>
          <span className="hx-who">Staygreen says</span>
          <span className="hx-state">
            {sg.cls === "busy" ? <Loader2 width={22} height={22} className="spin" aria-hidden="true" /> : <StateIcon state={sg.cls === "down" ? "down" : "up"} size={22} />}
            {sg.word}
          </span>
          <span className="hx-why">{sg.why}</span>
        </div>
      </div>

      <div className="hx-foot">
        {broken ? (
          <button type="button" className="btn btn-lg" onClick={fixIt}>Fix the database</button>
        ) : (
          <button type="button" className="btn btn-lg btn-ink" onClick={breakIt}>Break the database</button>
        )}
        <span className="hx-note">
          {phase === "down" ? "This is when Staygreen alerts you, with the response that failed." : phase === "up" ? "An example on sample data. Nothing real is touched." : " "}
        </span>
      </div>
    </div>
  );
}
