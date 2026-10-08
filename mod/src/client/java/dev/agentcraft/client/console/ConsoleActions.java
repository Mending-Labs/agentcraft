package dev.agentcraft.client.console;

import dev.agentcraft.client.console.ConsoleCommands.AgentAction;
import dev.agentcraft.client.console.ConsoleCommands.Auto;
import dev.agentcraft.client.console.ConsoleCommands.Answer;
import dev.agentcraft.client.console.ConsoleCommands.Clear;
import dev.agentcraft.client.console.ConsoleCommands.Command;
import dev.agentcraft.client.console.ConsoleCommands.Decide;
import dev.agentcraft.client.console.ConsoleCommands.Empty;
import dev.agentcraft.client.console.ConsoleCommands.Goal;
import dev.agentcraft.client.console.ConsoleCommands.Help;
import dev.agentcraft.client.console.ConsoleCommands.Intent;
import dev.agentcraft.client.console.ConsoleCommands.Invalid;
import dev.agentcraft.client.console.ConsoleCommands.Message;
import dev.agentcraft.client.console.ConsoleCommands.RepoAdd;
import dev.agentcraft.client.console.ConsoleCommands.Repos;
import dev.agentcraft.client.console.ConsoleCommands.ShowDiff;
import dev.agentcraft.client.console.ConsoleCommands.Sound;
import dev.agentcraft.client.console.ConsoleCommands.Status;
import dev.agentcraft.client.console.ConsoleCommands.TaskAction;
import dev.agentcraft.client.console.ConsoleLog.Tone;
import dev.agentcraft.client.decisions.DecisionQueue;
import dev.agentcraft.client.decisions.DecisionsFeature;
import dev.agentcraft.client.decisions.DiffLink;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol.Ack;
import dev.agentcraft.client.foreman.Protocol.Agent;
import dev.agentcraft.client.foreman.Protocol.Decision;
import dev.agentcraft.client.foreman.Protocol.Repo;
import dev.agentcraft.client.foreman.Protocol.Task;
import dev.agentcraft.client.foreman.Protocol.TaskStatus;
import dev.agentcraft.client.hud.HudSounds;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.ui.Tr;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * Runs console intents: sends them to the Foreman, then reports the ack in the status line next to
 * the input ("sent to Juniper ✓" / the Foreman's error) and, for errors and local commands, as
 * console lines. Failed sends hand the input back so it can be fixed and re-sent.
 */
public final class ConsoleActions {
	/** The latest feedback for the status line. {@code pending}: still waiting for the ack. */
	public record Feedback(String text, Tone tone, long at, boolean pending) {
	}

	/** What the console does with its input after Enter. */
	public enum After {
		CLEAR, KEEP, CLOSE
	}

	private static volatile @Nullable Feedback feedback;
	private static int sentCount;
	private static int ackOkCount;
	private static int ackErrorCount;
	private static @Nullable String lastSent;

	private ConsoleActions() {
	}

	public static @Nullable Feedback feedback() {
		return feedback;
	}

	public static void setFeedback(String text, Tone tone, boolean pending) {
		feedback = new Feedback(text, tone, System.currentTimeMillis(), pending);
	}

	public static void clearFeedback() {
		feedback = null;
	}

	public static @Nullable String lastSent() {
		return lastSent;
	}

	public static Map<String, Object> stats() {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("sent", sentCount);
		m.put("ackOk", ackOkCount);
		m.put("ackError", ackErrorCount);
		m.put("lastSent", lastSent);
		Feedback f = feedback;
		m.put("feedback", f == null ? null : f.text());
		m.put("feedbackTone", f == null ? null : f.tone().name().toLowerCase(java.util.Locale.ROOT));
		return m;
	}

	/**
	 * Run an intent. {@code raw} is the input as typed (kept in history); {@code restore} puts text
	 * back into the input when a send fails (the screen ignores it once closed).
	 */
	public static After run(Intent in, String raw, Consumer<String> restore) {
		ForemanState s = Foreman.state();
		switch (in) {
			case Empty e -> {
				return After.KEEP;
			}
			case Invalid i -> {
				setFeedback(i.error(), Tone.ERROR, false);
				return After.KEEP;
			}
			case Help h -> {
				ConsoleLog.remember(raw);
				help(h.topic());
				clearFeedback();
				return After.CLEAR;
			}
			case Status st -> {
				ConsoleLog.remember(raw);
				status(s);
				clearFeedback();
				return After.CLEAR;
			}
			case Repos r -> {
				ConsoleLog.remember(raw);
				repos(s);
				clearFeedback();
				return After.CLEAR;
			}
			case Clear c -> {
				ConsoleLog.remember(raw);
				ConsoleLog.clearLocal();
				clearFeedback();
				return After.CLEAR;
			}
			case Auto au when au.on() == null -> {
				ConsoleLog.remember(raw);
				boolean on = s.status() != null && Boolean.TRUE.equals(s.status().auto());
				ConsoleLog.add(Tone.INFO, Tr.t("console.auto_line", Tr.t(on ? "console.auto_state_on" : "console.auto_state_off")));
				clearFeedback();
				return After.CLEAR;
			}
			case Auto au -> track(Foreman.setAuto(au.on()), raw, restore,
				ack -> Tr.t(au.on() ? "console.auto_on" : "console.auto_off") + " " + UiBits.CHECK, Tr.t("console.auto_sending") + "…");
			case Sound so -> {
				ConsoleLog.remember(raw);
				if (so.on() != null) {
					HudSounds.setEnabled(so.on());
				}
				String state = HudSounds.enabled() ? Tr.t("console.sound_state_on") : Tr.t("console.sound_state_off");
				String why = HudSounds.forcedMute() ? " " + Tr.t("console.sound_forced_mute") : "";
				ConsoleLog.add(Tone.INFO, Tr.t("console.sound_line", state, why));
				clearFeedback();
				return After.CLEAR;
			}
			case Decide d -> {
				ConsoleLog.remember(raw);
				clearFeedback();
				DecisionsFeature.openQueue(d.decisionId(), net.minecraft.client.Minecraft.getInstance().gui.screen());
				return After.CLOSE;
			}
			case ShowDiff d -> {
				ConsoleLog.remember(raw);
				clearFeedback();
				if (DiffLink.hasDiffScreen()) {
					DiffLink.open(d.repoId(), d.worktree(), d.decision(), null);
					return After.CLOSE;
				}
				// no diff screen in this build: print a summary into the console
				setFeedback(Tr.t("console.diff_fetching", d.worktree()) + "\u2026", Tone.INFO, true);
				DiffLink.summary(d.repoId(), d.worktree()).thenAccept(lines -> {
					for (DiffLink.SummaryLine l : lines) {
						if (l.header() || l.error()) {
							ConsoleLog.add(l.header() ? Tone.HEADER : Tone.ERROR, l.text());
						} else if (l.additions() + l.deletions() > 0) {
							ConsoleLog.add(Tone.FILE, l.text() + "\t+" + l.additions() + "\t\u2212" + l.deletions());
						} else {
							ConsoleLog.add(Tone.INFO, l.text());
						}
					}
					setFeedback(Tr.t("console.diff_below", d.worktree()), Tone.OK, false);
				});
				return After.CLEAR;
			}
			default -> {
			}
		}
		if (!Foreman.connected()) {
			setFeedback(Tr.t("console.offline_not_sent"), Tone.ERROR, false);
			return After.KEEP;
		}
		ConsoleLog.remember(raw);
		lastSent = raw.strip();
		switch (in) {
			case Goal g -> track(Foreman.submitGoal(g.text(), g.repoId()), raw, restore, ack -> {
				String gid = ack.result() != null && ack.result().has("goalId") ? ack.result().get("goalId").getAsString() : null;
				return (gid != null ? Tr.t("console.goal_sent_id", gid) : Tr.t("console.goal_sent")) + (g.repoId() != null && s.repos().size() > 1
					? " \u2192 " + ConsoleCommands.repoName(g.repoId(), s) : "") + " " + UiBits.CHECK;
			}, Tr.t("console.goal_sending") + "\u2026");
			case Message m -> track(Foreman.message(m.to(), m.text()), raw, restore,
				ack -> Tr.t("console.message_sent", ConsoleCommands.displayName(m.to(), s)) + " " + UiBits.CHECK,
				Tr.t("console.message_sending", ConsoleCommands.displayName(m.to(), s)) + "\u2026");
			case Answer a -> {
				String did = a.decision().id();
				DecisionsFeature.markAnswering(did);
				// a refused answer must show up again on the HUD badge and the podium at once
				track(Foreman.answer(did, a.option(), a.text()), raw, restore,
					ack -> (a.option() != null ? Tr.t("console.answered_option", did, a.option()) : Tr.t("console.answered", did)) + " " + UiBits.CHECK,
					Tr.t("console.answering", did) + "\u2026",
					() -> DecisionsFeature.unmarkAnswering(did));
			}
			case RepoAdd r -> track(Foreman.addRepo(r.path()), raw, restore, ack -> {
				String rid = ack.result() != null && ack.result().has("repoId") ? ack.result().get("repoId").getAsString() : null;
				return (rid != null ? Tr.t("console.repo_added_id", rid) : Tr.t("console.repo_added")) + " " + UiBits.CHECK;
			}, Tr.t("console.repo_adding") + "\u2026");
			case AgentAction a -> {
				List<CompletableFuture<Ack>> all = new ArrayList<>();
				for (String id : a.agentIds()) {
					all.add(Foreman.agentAction(id, a.action(), a.arg()));
				}
				CompletableFuture<Ack> combined = CompletableFuture.allOf(all.toArray(CompletableFuture[]::new)).thenApply(v -> {
					for (CompletableFuture<Ack> f : all) {
						Ack ack = f.join();
						if (!ack.ok()) {
							return ack;
						}
					}
					return all.get(0).join();
				});
				String who = a.agentIds().size() == 1 ? ConsoleCommands.displayName(a.agentIds().get(0), s) : Tr.t("console.n_agents", a.agentIds().size());
				track(combined, raw, restore, ack -> agentDone(a.action(), who) + (a.arg() != null ? " " + Tr.t("console.on_task", a.arg()) : "") + " "
					+ UiBits.CHECK, ConsoleCommands.agentActionText(a.action(), who) + "\u2026");
			}
			case TaskAction t -> track(Foreman.taskAction(t.taskId(), t.action(), t.arg()), raw, restore,
				ack -> taskDone(t.action(), t.taskId()) + (t.arg() != null ? " \u2192 " + t.arg() : "") + " " + UiBits.CHECK,
				ConsoleCommands.taskActionText(t.action(), t.taskId()) + "\u2026");
			default -> {
				return After.KEEP;
			}
		}
		return After.CLEAR;
	}

	/** "paused Kit": an agent action that went through ({@code verb} is the wire action). */
	private static String agentDone(String verb, String who) {
		return switch (verb) {
			case "pause", "resume", "stop", "spawn" -> Tr.t("console.done_agent_" + verb, who);
			default -> verb + "ed " + who;
		};
	}

	/** "t5 cancelled": a task action that went through ({@code verb} is the wire action). */
	private static String taskDone(String verb, String taskId) {
		return switch (verb) {
			case "cancel", "retry", "prioritize", "reassign" -> Tr.t("console.done_task_" + verb, taskId);
			default -> taskId + " " + verb + "ed";
		};
	}

	private interface OkText {
		String text(Ack ack);
	}

	private static void track(CompletableFuture<Ack> f, String raw, Consumer<String> restore, OkText ok, String pending) {
		track(f, raw, restore, ok, pending, null);
	}

	/** {@code onError} runs (client thread) when the send fails or the Foreman refuses it. */
	private static void track(CompletableFuture<Ack> f, String raw, Consumer<String> restore, OkText ok, String pending, @Nullable Runnable onError) {
		sentCount++;
		setFeedback(pending, Tone.INFO, true);
		f.whenComplete((ack, err) -> {
			if (err == null && ack != null && ack.ok()) {
				ackOkCount++;
				setFeedback(ok.text(ack), Tone.OK, false);
				return;
			}
			ackErrorCount++;
			String msg;
			if (err != null) {
				Throwable c = err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
				msg = c.getMessage() != null ? c.getMessage() : c.getClass().getSimpleName();
			} else {
				msg = ack == null ? Tr.t("console.no_answer") : ack.error() != null ? ack.error() : Tr.t("console.refused");
			}
			setFeedback(msg, Tone.ERROR, false);
			ConsoleLog.add(Tone.ERROR, UiBits.CROSS + " " + ConsoleCommands.oneLine(raw, 60) + ": " + msg);
			if (onError != null) {
				onError.run();
			}
			restore.accept(raw);
		});
	}

	// ------------------------------------------------------------------ local commands

	private static void help(@Nullable String topic) {
		ConsoleLog.add(Tone.HEADER, Tr.t("console.title"));
		ConsoleLog.add(Tone.HELP, Tr.t("console.help_plain_text") + "\t" + Tr.t("console.help_plain_text_desc"));
		ConsoleLog.add(Tone.HELP, Tr.t("console.help_at_agent") + "\t" + Tr.t("console.help_at_agent_desc"));
		for (Command c : ConsoleCommands.commands()) {
			if (topic == null || c.name().startsWith(topic)) {
				ConsoleLog.add(Tone.HELP, c.usage() + "\t" + c.help());
			}
		}
		ConsoleLog.add(Tone.INFO, Tr.t("console.help_keys", dev.agentcraft.client.hud.Keys.label(dev.agentcraft.client.hud.Keys.decisions)));
	}

	private static void status(ForemanState s) {
		ConsoleLog.add(Tone.HEADER, Tr.t("console.status_title"));
		if (!s.hasData()) {
			ConsoleLog.add(Tone.ERROR, Tr.t("console.no_data_yet"));
			return;
		}
		if (s.isStale()) {
			ConsoleLog.add(Tone.ERROR, Tr.t("console.offline_last_known"));
		}
		var g = s.goal();
		if (g != null) {
			ConsoleLog.add(Tone.INFO, Tr.t("console.goal_line", g.id(), goalStatusLabel(g.status()), Math.round(g.progress() * 100),
				ConsoleCommands.oneLine(g.text(), 90)));
		} else {
			ConsoleLog.add(Tone.INFO, Tr.t("console.no_goal_yet"));
		}
		Map<TaskStatus, Integer> counts = new LinkedHashMap<>();
		for (TaskStatus ts : List.of(TaskStatus.DOING, TaskStatus.REVIEW, TaskStatus.TODO, TaskStatus.BLOCKED, TaskStatus.DONE)) {
			counts.put(ts, 0);
		}
		for (Task t : s.tasks().values()) {
			counts.computeIfPresent(t.status(), (k, v) -> v + 1);
		}
		StringBuilder tb = new StringBuilder(Tr.t("console.tasks_prefix")).append(' ');
		counts.forEach((k, v) -> tb.append(v).append(' ').append(taskStatusLabel(k)).append("  "));
		ConsoleLog.add(Tone.INFO, tb.toString().strip());
		String spend = spendLabel(s);
		if (spend != null) {
			ConsoleLog.add(Tone.INFO, Tr.t("console.spend_line", spend));
		}
		for (Agent a : s.agents().values()) {
			String st = !a.isActive() ? Tr.t("console.off_shift") : a.isPaused() ? Tr.t("console.paused") : agentStateLabel(a.state());
			ConsoleLog.add(Tone.INFO, a.name() + " \u00b7 " + st + (a.activity().isEmpty() ? "" : " \u00b7 " + a.activity()) + (a.taskId() != null ? " ("
				+ a.taskId() + ")" : ""), a.id());
		}
		List<Decision> open = DecisionQueue.open();
		if (open.isEmpty()) {
			ConsoleLog.add(Tone.OK, Tr.t("console.no_decisions_waiting"));
		} else {
			for (Decision d : open) {
				ConsoleLog.add(Tone.INFO, d.id() + " " + DecisionQueue.kindLabel(d.kind()) + ": " + ConsoleCommands.oneLine(d.question(), 80), d.agentId());
			}
		}
	}

	/** Display label of a task status (the wire value is unchanged). */
	private static String taskStatusLabel(TaskStatus st) {
		return switch (st) {
			case TODO, DOING, REVIEW, DONE, BLOCKED, CANCELLED -> Tr.t("console.task_status_" + st.wire());
			default -> st.wire();
		};
	}

	/** Display label of a goal status (the wire value is unchanged). */
	private static String goalStatusLabel(dev.agentcraft.client.foreman.Protocol.GoalStatus st) {
		return switch (st) {
			case PLANNING, ACTIVE, DONE, FAILED, CANCELLED -> Tr.t("console.goal_status_" + st.wire());
			default -> st.wire();
		};
	}

	/** Display label of an agent state (the wire value is unchanged). */
	private static String agentStateLabel(dev.agentcraft.client.foreman.Protocol.AgentState st) {
		return switch (st) {
			case UNKNOWN -> st.wire();
			default -> Tr.t("console.agent_state_" + st.wire());
		};
	}

	/** "$2.46" for the claude backend once something was spent, else null. */
	static @Nullable String spendLabel(ForemanState s) {
		var st = s.status();
		if (st == null || st.costUsd() == null || st.costUsd() <= 0) {
			return null;
		}
		return String.format(java.util.Locale.ROOT, "$%.2f", st.costUsd());
	}

	private static void repos(ForemanState s) {
		ConsoleLog.add(Tone.HEADER, Tr.t("console.repos_title"));
		if (s.repos().isEmpty()) {
			String example = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")
				? "C:\\path\\to\\repo" : "/path/to/repo";
			ConsoleLog.add(Tone.INFO, Tr.t("console.repos_none", "/repo add " + example));
			return;
		}
		for (Repo r : s.repos().values()) {
			ConsoleLog.add(Tone.INFO, r.name() + " \u00b7 " + r.branch() + (r.head() != null ? " @ " + r.head() : "") + (r.dirty()
				? " \u00b7 " + Tr.t("console.uncommitted_changes") : "") + " \u00b7 " + r.path());
		}
	}
}
