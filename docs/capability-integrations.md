# Packages, extensions, skills, and MCP

GooeyPi presents one capability directory for Prime Agent, OMP, and Pi, but it
must not pretend that the three harnesses install or authenticate capabilities
the same way. This document defines the product contract for that surface.

## Shared vocabulary

- A **package** is a distribution container. Prime Agent and Pi packages can
  contain extensions, skills, prompts, and themes.
- An **extension** is executable JavaScript or TypeScript loaded into the agent
  host. Installing an extension means installing its package or placing its
  file in a harness-native extension directory.
- A **skill** is model-facing guidance. Prime Agent additionally supports
  Python-backed skills installed into its IPython kernel environment.
- An **MCP server** is a connection definition. It is not itself a package,
  extension, or skill, although a package may provide one or more of those
  resources and may declare MCP servers.
- An OMP **plugin** is an OMP-native bundle that can provide skills, commands,
  agents, hooks, tools, MCP servers, LSP servers, and extension modules.

## Harness contracts

| Harness | Installable bundle | Standalone extension | MCP runtime | MCP configuration | Interactive authentication |
| --- | --- | --- | --- | --- | --- |
| Prime Agent | `prime-agent package install <source>` | Local file through `package install`; `--local` for project scope | A matching Python-backed `McpIntegration` skill | User `~/.prime/agent/settings.json` or project `.prime/agent/settings.json`; HTTP only | `/mcp login <name>`; credentials remain in Prime Agent auth storage |
| OMP | `omp plugin install <target> --json` | Copy one local module into user `~/.omp/agent/extensions/` or project `.omp/extensions/` | Native | User `~/.omp/agent/mcp.json` or project `.omp/mcp.json` | `/mcp reauth <name>`; credentials remain in the active OMP profile |
| Pi | `pi install <source>` | Local file through `pi install`; `-l` for project scope | `pi-mcp-adapter` extension package | User `~/.pi/agent/mcp.json` or project `.pi/mcp.json` | `/mcp-auth <name>`; credentials remain in the OS secure credential store |

The app labels this surface **Capabilities** for every harness. Its Add button
first opens a capability-type chooser, then a type-specific form: **Add MCP**,
**Add Plugin** (OMP) or **Add Package** (Prime/Pi), and **Add Extension**. Pi's
MCP choice remains visible but disabled until its adapter toggle is enabled.

## Product behavior

### Prime Agent

Prime Agent has no MCP enable toggle. Its built-in Linear and Notion
integrations become enabled when the user authenticates. A custom integration
requires both an HTTP server definition and a package containing the matching
Python-backed integration skill. GooeyPi therefore installs the package and
writes the server definition as one guided flow. It never offers stdio MCP to
Prime Agent because Prime's kernel integration does not support it.

OAuth is launched inside the active Prime Agent session with `/mcp login
<name>`. Static bearer authentication stores only an environment-variable name
in configuration; GooeyPi never asks for or persists the token.

### OMP

OMP has native MCP support, so no enable toggle is shown. GooeyPi writes only
OMP-native MCP files and installs plugins only through `omp plugin`. OAuth is
launched inside the active OMP session with `/mcp reauth <name>`, leaving the
project connection definition credential-free and profile-specific credentials
in OMP's own auth storage.

OMP marketplace targets use `name@marketplace`. Repository and local targets
remain accepted where the OMP CLI accepts them.

### Pi

Pi core has no MCP client. GooeyPi shows **MCP | Pi MCP Adapter** as a real
toggle whose state is derived from Pi's installed packages. Enabling it runs
`pi install npm:pi-mcp-adapter`; disabling it runs `pi remove` for the recorded
adapter source. Disabling does not delete MCP definitions or credentials, so a
later re-enable restores the connections without silently losing user data.

Only after the adapter is installed may GooeyPi write its supported `mcp.json`
schema. OAuth is launched inside the active Pi session with `/mcp-auth <name>`.
The adapter owns its secure credential storage and fails closed when the OS
credential store is unavailable.

## Security boundaries

- Every install/remove command uses the detected fixed harness executable and
  an argv array; no shell interpolation is permitted.
- Package, plugin, server, URL, command, argument, and environment-variable
  inputs are bounded and validated in the main process.
- Standalone extensions must be absolute local JavaScript or TypeScript files.
  Project installs are re-authorized and their destination directories remain
  pinned against symlink replacement; existing OMP extension files are never
  overwritten.
- MCP settings retain the existing lock, conflict retry, project-directory
  pinning, atomic replacement, and rollback protections.
- GooeyPi never reads or writes Prime/Pi auth files or OMP's `agent.db`.
- OAuth must run through the owning harness so refresh, logout, profiles, and
  credential storage keep their native semantics.
