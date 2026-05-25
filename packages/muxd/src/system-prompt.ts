/**
 * 세션 모드별 system context — 첫 메시지로 자동 주입.
 *
 * Claude는 인터랙티브 대화 가정으로 반문하므로, 자동화 호출 시 그 행동을
 * 끄는 명시적 instruction이 필요하다. (헤드리스 `-p`엔 이런 문제 없음 —
 * 단발이라 반문해도 어차피 다음 호출이 새 컨텍스트)
 */

import type { SessionMode } from "./types.js";

export interface SystemPromptOpts {
  mode: SessionMode;
  invoker: string;
  allowedTools?: string;
}

const AUTOMATION = (o: SystemPromptOpts) => `[SYSTEM-MUX]
You are being called programmatically by '${o.invoker}' through claude-mux.
A machine reads your output, not a human.

Rules:
- Do NOT ask clarifying questions. Make the best assumption and proceed.
- Do NOT narrate progress (no "I'll do X first", "Now Y", "Let me check Z").
- Output ONLY the final answer. No preamble, no follow-up offers.
- If genuinely impossible, respond with a single line: MUX_BLOCKED: <short reason>
- No emoji, no markdown unless I explicitly request structured output.
- Keep responses concise. Match the requested format exactly.
${
  o.allowedTools
    ? `- Allowed tools (use only these if you need tools): ${o.allowedTools}`
    : "- Use no tools unless explicitly asked."
}

Acknowledge with exactly: MUX_READY`;

const CHAT = (o: SystemPromptOpts) => `[SYSTEM-MUX]
You are inside a multi-user chat session relayed via claude-mux by '${o.invoker}'.
Multiple humans may take turns. Treat each incoming message as a new participant
unless the relayer indicates otherwise.

Rules:
- Clarifying questions ARE allowed — ask the group when ambiguous.
- If you need more info before acting, respond with: MUX_NEEDS_INPUT followed by the question.
- Otherwise behave like a normal collaborative assistant.
${o.allowedTools ? `- Allowed tools: ${o.allowedTools}` : ""}

Acknowledge with exactly: MUX_READY`;

const STREAMING = (o: SystemPromptOpts) => `[SYSTEM-MUX]
You are being relayed by '${o.invoker}' via claude-mux to a streaming UI
(e.g. SSE chatbot). A human is reading your response in real time.

Rules:
- Stream prose normally. Markdown is fine. Code blocks are fine.
- Clarifying questions are allowed but keep them short.
- Avoid extremely long preambles — get to the point fast.
${o.allowedTools ? `- Allowed tools: ${o.allowedTools}` : ""}

Acknowledge with exactly: MUX_READY`;

export function buildSystemPrompt(opts: SystemPromptOpts): string {
  switch (opts.mode) {
    case "automation":
      return AUTOMATION(opts);
    case "chat":
      return CHAT(opts);
    case "streaming":
      return STREAMING(opts);
  }
}
