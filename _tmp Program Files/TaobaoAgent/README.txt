Taobao Agent (portable)

Server:
  https://tb.slee.cc

WebSocket:
  wss://tb.slee.cc/ws/agent

Usage:
  1) First time pairing (run on the agent machine):
     pair-agent.cmd <PAIR_CODE>

  2) Next time:
     start-agent.cmd

Notes:
  - If Chrome/Chromium is not installed, Agent will auto-download Chrome for Testing on first run (needs Internet).
  - Agent token + agentId are stored in %ProgramData%\TaobaoAgent\agent.json
