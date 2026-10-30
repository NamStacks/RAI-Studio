// The packaged bridge no longer writes mcpServers.rai. Each Claude session
// gets one owner-only key, rai_studio_session_<uuid>, so a native rai server
// cannot satisfy RAI approvals. The scripted providers spawn that server
// directly; they only need the single session entry from --mcp-config.
export function sessionMcpServer(config) {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    return undefined;
  if (servers.rai)
    return servers.rai;
  const names = Object.keys(servers).filter((name) => name.startsWith('rai_studio_session_'));
  return names.length === 1 ? servers[names[0]] : undefined;
}
