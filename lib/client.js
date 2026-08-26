window.__ModuleLoader__.load({
	id: "dsh-tool-gitbash",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region shared helpers
		/** Parse the wire args JSON into an object, or null when it is not an object. */
		function parseArgs(argsRaw) {
			try {
				const parsed = JSON.parse(argsRaw);
				return typeof parsed === "object" && parsed !== null ? parsed : null;
			} catch {
				return null;
			}
		}
		/** Flatten a settled result's content blocks to display text. */
		function resultText(block) {
			const text = (block.content || []).map((item) => item.type === "text" ? item.text : JSON.stringify(item, null, 2)).join("\n");
			if (text !== "") return text;
			return block.error === void 0 ? null : `${block.error.name}: ${block.error.code}`;
		}
		/** Call state from a frozen running-or-settled node. */
		function stateOf(block) {
			if (!("kind" in block)) return "running";
			if (block.error?.code === "interrupted") return "stopped";
			return block.isError ? "error" : "ok";
		}
		const STATE_COLORS = {
			running: "#4b7bec",
			ok: "#2f9e44",
			error: "#e03131",
			stopped: "#e8a50a"
		};
		const STATE_LABELS = {
			running: "运行中",
			ok: "完成",
			error: "失败",
			stopped: "已中断"
		};
		const monoStyle = {
			fontFamily: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)",
			fontSize: "13px",
			lineHeight: "22px",
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			margin: 0
		};
		const cardStyle = {
			border: "1px solid var(--dsw-alias-border-l1, #e2e8f0)",
			borderRadius: "8px",
			overflow: "hidden",
			background: "var(--dsw-alias-bg-base, #ffffff)",
			fontSize: "14px",
			color: "var(--dsw-alias-label-primary, #1a1a2e)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "6px 12px",
			minHeight: "24px"
		};
		const blockStyle = {
			background: "var(--dsw-alias-markdown-code-block, #f6f8fa)",
			borderRadius: "6px",
			padding: "8px 10px"
		};
		const blockLabelStyle = {
			fontSize: "11px",
			color: "var(--dsw-alias-label-caption, #999)",
			marginBottom: "4px"
		};
		/** State dot + title + status label + chevron header for a card. */
		function CardHeader({ state, title, expandable, open, onToggle }) {
			return react.createElement("div", {
				onClick: expandable ? onToggle : undefined,
				style: Object.assign({}, rowStyle, expandable ? { cursor: "pointer" } : {})
			},
				react.createElement("span", {
					"aria-hidden": true,
					style: { width: "8px", height: "8px", borderRadius: "50%", background: STATE_COLORS[state] ?? "#aaa", flex: "none" }
				}),
				react.createElement("span", { style: { fontWeight: 600, flex: "none" } }, title),
				react.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" } }, STATE_LABELS[state] ?? state),
				react.createElement("span", { style: { flex: 1 } }),
				expandable && react.createElement("span", {
					"aria-hidden": true,
					style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)", transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }
				}, "▾")
			);
		}
		//#endregion
		//#region gitbash card
		const gitBashHeaderStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "8px 12px"
		};
		const gitBashSubStyle = {
			padding: "0 12px 6px",
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary, #888)"
		};
		/** Collapsible card for the gitbash tool: compact header row, body expanded on click. */
		function GitBashRow(props) {
			const { block } = props;
			const call = block.callView?.card === "terminal" ? block.callView : null;
			const settled = "kind" in block;
			const result = settled && block.resultView?.card === "terminal" ? block.resultView : null;
			const command = result?.title ?? call?.title ?? "";
			const cwd = call?.cwd;
			const description = call?.description;
			const output = result === null ? null : (result.output ?? "");
			const exitCode = result?.exitCode ?? null;
			const signal = result?.signal ?? null;
			const state = !settled ? "running" : signal !== null && signal !== void 0 ? "stopped" : exitCode !== null && exitCode !== 0 ? "error" : "ok";
			const heading = command !== "" ? command : "Git Bash";
			const [expanded, setExpanded] = react.useState(false);
			const expandable = (cwd !== void 0 && cwd !== "") || (description !== void 0 && description !== "") || (output !== null && output !== "");
			const open = expanded && expandable;
			return react.createElement("div", { style: cardStyle },
				react.createElement("div", {
					onClick: expandable ? () => setExpanded((v) => !v) : undefined,
					style: Object.assign({}, gitBashHeaderStyle, expandable ? { cursor: "pointer" } : {})
				},
					react.createElement("span", { "aria-hidden": true, style: { width: "8px", height: "8px", borderRadius: "50%", background: STATE_COLORS[state] ?? "#aaa", flex: "none" } }),
					react.createElement("span", { style: { fontWeight: 600, flex: "none" } }, heading),
					react.createElement("span", { style: { flex: 1 } }),
					react.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" } }, STATE_LABELS[state] ?? state),
					exitCode !== null && exitCode !== void 0 && react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #aaa)", border: "1px solid var(--dsw-alias-border-l1, #e2e8f0)", borderRadius: "4px", padding: "0 6px" } }, "exit " + exitCode),
					expandable && react.createElement("span", { "aria-hidden": true, style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #aaa)", transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" } }, "▾")
				),
				open && react.createElement("div", { style: { padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: "6px" } },
					cwd !== void 0 && cwd !== "" && react.createElement("div", { style: gitBashSubStyle }, cwd),
					description !== void 0 && description !== "" && react.createElement("div", { style: gitBashSubStyle }, description),
					output !== null && output !== "" && react.createElement("pre", { style: Object.assign({}, monoStyle, { maxHeight: "240px", overflow: "auto" }), children: output })
				)
			);
		}
		//#endregion
		//#region generic titled cards
		/** Display titles for model tools that ship without a keyed toolview card. */
		const KEY_TITLES = {
			cordis_inspect_list: "Inspect",
			cordis_inspect_query: "Inspect",
			cordis_inspect_self: "Inspect",
			subagent: "Subagent",
			subagent_fork: "Subagent (Fork)",
			list_agents: "List Agents",
			send_message: "Send Message",
			interrupt_agent: "Interrupt Agent",
			workflow: "Workflow",
			ralph: "Ralph",
			create_goal: "Create Goal",
			get_goal: "Get Goal",
			update_goal: "Update Goal",
			exit_plan_mode: "Submit Plan",
			job_kill: "Kill Job",
			job_list: "List Jobs",
			job_output: "Job Output",
			read_image: "Read Image",
			vision_toolkit_activate: "Vision Toolkit",
			workbench_session_delete: "Delete Session"
		};
		/** Arg keys tried in order for a one-line summary. */
		const SUMMARY_KEYS = [
			"description",
			"objective",
			"purpose",
			"query",
			"path",
			"file_path",
			"prompt",
			"job_id",
			"subagent_id",
			"agent_id",
			"plugin_id",
			"provider",
			"method",
			"session_id",
			"scope",
			"action",
			"message",
			"name"
		];
		function firstString(args, keys) {
			for (const key of keys) {
				const value = args[key];
				if (typeof value === "string" && value !== "") return value;
			}
			if (typeof args.meta === "object" && args.meta !== null) {
				const metaName = args.meta.name;
				if (typeof metaName === "string" && metaName !== "") return metaName;
			}
			return null;
		}
		function GenericTitleRow(props) {
			const { block, toolName } = props;
			const settled = "kind" in block;
			const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
			const args = parseArgs(argsRaw);
			const title = KEY_TITLES[toolName] ?? "Tool call";
			const summary = args === null ? null : firstString(args, SUMMARY_KEYS);
			const state = stateOf(block);
			const output = settled ? resultText(block) : null;
			const [expanded, setExpanded] = react.useState(false);
			const hasArgs = args !== null && Object.keys(args).length > 0;
			const expandable = hasArgs || output !== null;
			const open = expanded && expandable;
			return react.createElement("div", { style: cardStyle },
				react.createElement(CardHeader, { state, title, expandable, open, onToggle: () => setExpanded((v) => !v) }),
				summary !== null && react.createElement("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: "8px",
						padding: "0 12px 8px",
						fontSize: "13px",
						color: "var(--dsw-alias-label-secondary, #555)",
						minWidth: 0
					}
				},
					react.createElement("span", { style: { flexShrink: 0, color: "var(--dsw-alias-label-caption, #999)" } }, "摘要"),
					react.createElement("span", {
						style: {
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							minWidth: 0
						}
					}, summary)
				),
				open && react.createElement("div", { style: { padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: "8px" } },
					hasArgs && react.createElement("div", { style: blockStyle },
						react.createElement("div", { style: blockLabelStyle }, "参数"),
						react.createElement("pre", {
							style: Object.assign({}, monoStyle, { maxHeight: "224px", overflow: "auto" }),
							children: JSON.stringify(args, null, 2)
						})
					),
					output !== null && react.createElement("div", { style: blockStyle },
						react.createElement("div", { style: blockLabelStyle }, "输出"),
						react.createElement("pre", {
							style: Object.assign({}, monoStyle, {
								maxHeight: "224px",
								overflow: "auto",
								color: state === "error" ? "var(--dsw-alias-state-error-primary, #c0392b)" : "var(--dsw-alias-label-primary, #333)"
							}),
							children: output
						})
					)
				)
			);
		}
		//#endregion
		//#region plugin
		const inject = ["slots"];
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("tool.call.toolview", function* () {
				yield slots.register({ name: "tool.call.toolview", key: "gitbash" }, GitBashRow);
				for (const key of Object.keys(KEY_TITLES)) {
					yield slots.register({ name: "tool.call.toolview", key }, GenericTitleRow);
				}
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
