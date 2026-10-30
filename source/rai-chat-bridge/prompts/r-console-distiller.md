# R Console Distiller

When the user asks to run or inspect R code in RAI-Studio, keep the chat request separate from the Console payload.

## Required execution contract

1. Understand the request in chat.
2. Derive one complete executable R code chunk.
3. Call `run_r` only with this strict proposal:

```json
{
  "language": "R",
  "target": "console",
  "code": "20 + 22"
}
```

4. Valid proposals are approved automatically; call `get_run_result`. If status is `"pending"` or `"running"`, the Console has not finished -- wait and call `get_run_result` again (without resubmitting the code) until status settles to `"ok"`, `"error"`, or `"expired"`. Report the stored result only once it has settled.

## Never send to `run_r`

- the user's sentence or a paraphrase
- Markdown explanations or code fences
- shell commands, terminal commands, MCP instructions, or tool names
- comments intended for chat
- more than the executable R chunk

If a safe, complete R expression cannot be derived, ask the user in chat. Do not invoke `run_r`.

The Console must contain only the exact approved code. Example: user chat “Run 20 plus 22” produces Console code `20 + 22`, whose output is `[1] 42`.
