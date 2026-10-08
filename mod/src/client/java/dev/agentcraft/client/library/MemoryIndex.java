package dev.agentcraft.client.library;

import dev.agentcraft.client.diff.ReviewKit;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.ui.Tr;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The memory entries as the library shows them. The screen reads them by {@link Tab} (kind of note,
 * archived notes apart), grouped by goal ({@link #sections}); the world's archive shelves read them by
 * scope ("shared" or an agent id, {@link #shelf}). Cached by Foreman revision (client thread).
 */
public final class MemoryIndex {
	public static final String ALL = "";

	/** Kinds the Foreman sends ({@code MemoryEntry.kind}). */
	public static final String PLAN = "plan";
	public static final String REPORT = "report";
	public static final String REVIEW = "review";
	public static final String SUMMARY = "summary";
	public static final String DECISION = "decision";
	public static final String NOTE = "note";

	/** Library tabs: every live note, one per kind, then the archived notes. */
	public enum Tab {
		ALL("all", null), PLANS("plans", PLAN), REPORTS("reports", REPORT), REVIEWS("reviews", REVIEW), SUMMARIES("summaries", SUMMARY), DECISIONS(
			"decisions", DECISION), ARCHIVES("archives", null);

		public final String wire;
		private final @Nullable String kind;

		Tab(String wire, @Nullable String kind) {
			this.wire = wire;
			this.kind = kind;
		}

		/** Archived notes only show under {@link #ARCHIVES}; the other tabs show live notes (of their kind). */
		public boolean accepts(MemoryEntry e) {
			if (this == ARCHIVES) {
				return e.isArchived();
			}
			return !e.isArchived() && (kind == null || kind.equals(kindOf(e)));
		}

		public String label() {
			return Tr.t("library.tab_" + wire);
		}

		/** A tab by wire name ("plans"...); anything else (null, "all", a scope from an archive binding) = {@link #ALL}. */
		public static Tab parse(@Nullable String s) {
			if (s != null) {
				for (Tab t : values()) {
					if (t.wire.equalsIgnoreCase(s.trim())) {
						return t;
					}
				}
			}
			return ALL;
		}
	}

	/** One goal's notes in display order ({@code goalId} null = general notes). */
	public record Section(@Nullable String goalId, List<MemoryEntry> entries) {
	}

	private static long revision = -1;
	private static List<MemoryEntry> all = List.of();
	private static Map<String, Integer> counts = Map.of();
	private static Map<Tab, Integer> tabCounts = Map.of();
	/** Unread tracking: entry id -> the {@code updated} the player has seen (or that existed at the first snapshot). */
	private static final Map<String, Long> SEEN = new HashMap<>();
	private static boolean seenInitialised;
	/** Folded (lower case, no accents) "title \n body" per entry version, for the search. */
	private static final Map<String, String> FOLDED = new HashMap<>();
	private static final Pattern MARKS = Pattern.compile("\\p{M}+");
	private static final Pattern SPACES = Pattern.compile("\\s+");

	private MemoryIndex() {
	}

	/** Wire the unread model: notes that exist at the first snapshot of the session count as read. */
	static void init() {
		Foreman.addListener(new dev.agentcraft.client.foreman.ForemanListener() {
			@Override
			public void onSnapshot(ForemanState state) {
				if (!seenInitialised) {
					seenInitialised = true;
					for (MemoryEntry e : state.memory().values()) {
						SEEN.put(e.id(), e.updated());
					}
				}
			}
		});
	}

	/** Written or changed since the player last read it (or since the session's first snapshot). */
	public static boolean isUnread(MemoryEntry e) {
		Long s = SEEN.get(e.id());
		return seenInitialised && (s == null || s < e.updated());
	}

	public static void markSeen(MemoryEntry e) {
		SEEN.put(e.id(), e.updated());
	}

	public static int unread(@Nullable String scope) {
		int n = 0;
		for (MemoryEntry e : entries(scope)) {
			if (isUnread(e)) {
				n++;
			}
		}
		return n;
	}

	private static void refresh() {
		ForemanState s = Foreman.state();
		if (s == null) {
			all = List.of();
			counts = Map.of();
			tabCounts = Map.of();
			revision = -1;
			return;
		}
		if (s.revision() == revision) {
			return;
		}
		revision = s.revision();
		List<MemoryEntry> list = new ArrayList<>(s.memory().values());
		list.sort(Comparator.comparingInt((MemoryEntry e) -> isPlan(e) ? 0 : 1).thenComparing(Comparator.comparingLong(MemoryEntry::updated)
			.reversed()));
		all = List.copyOf(list);
		Map<String, Integer> c = new LinkedHashMap<>();
		Map<Tab, Integer> t = new EnumMap<>(Tab.class);
		for (Tab tab : Tab.values()) {
			t.put(tab, 0);
		}
		for (MemoryEntry e : list) {
			c.merge(e.scope(), 1, Integer::sum);
			for (Tab tab : Tab.values()) {
				if (tab.accepts(e)) {
					t.merge(tab, 1, Integer::sum);
				}
			}
		}
		counts = Map.copyOf(c);
		tabCounts = Map.copyOf(t);
		if (FOLDED.size() > 4 * Math.max(64, list.size())) {
			FOLDED.clear();
		}
	}

	// ------------------------------------------------------------------ kinds

	/** The note's kind: the Foreman's {@code kind}, else (older Foreman) "plan" for the lead's plan, else "note". */
	public static String kindOf(MemoryEntry e) {
		if (e.kind() != null) {
			return e.kind();
		}
		return legacyPlan(e) ? PLAN : NOTE;
	}

	/** A plan: {@code kind} "plan" (or, without a kind, id {@code shared/plan} or a shared/lead entry titled "Plan..."). */
	public static boolean isPlan(MemoryEntry e) {
		return PLAN.equals(kindOf(e));
	}

	private static boolean legacyPlan(MemoryEntry e) {
		if (e.id().equals("shared/plan")) {
			return true;
		}
		String t = e.title().toLowerCase(Locale.ROOT);
		if (!t.startsWith("plan")) {
			return false;
		}
		if ("shared".equals(e.scope())) {
			return true;
		}
		ForemanState s = Foreman.state();
		Protocol.Agent a = s == null || e.author() == null ? null : s.agent(e.author());
		return a != null && a.role() == Protocol.AgentRole.LEAD;
	}

	// ------------------------------------------------------------------ tabs, goals, search

	public static int count(Tab tab) {
		refresh();
		return tabCounts.getOrDefault(tab, 0);
	}

	/**
	 * The notes of a tab that match the search, grouped by goal: the current goal first, then the
	 * other goals by their newest note (newest first), then the notes without a goal. In a section:
	 * the plan, then the summary, then the rest newest first.
	 */
	public static List<Section> sections(Tab tab, String query) {
		refresh();
		List<String> terms = terms(query);
		Map<String, List<MemoryEntry>> byGoal = new LinkedHashMap<>();
		List<MemoryEntry> general = new ArrayList<>();
		for (MemoryEntry e : all) {
			if (!tab.accepts(e) || !matches(e, terms)) {
				continue;
			}
			if (e.goalId() == null) {
				general.add(e);
			} else {
				byGoal.computeIfAbsent(e.goalId(), k -> new ArrayList<>()).add(e);
			}
		}
		ForemanState s = Foreman.state();
		String current = s == null || s.goal() == null ? null : s.goal().id();
		Map<String, Long> newest = new HashMap<>();
		byGoal.forEach((id, l) -> newest.put(id, l.stream().mapToLong(MemoryEntry::updated).max().orElse(0)));
		List<String> order = new ArrayList<>(byGoal.keySet());
		order.sort(Comparator.comparingInt((String id) -> id.equals(current) ? 0 : 1).thenComparing(Comparator.comparingLong((String id) -> newest.get(id))
			.reversed()));
		List<Section> out = new ArrayList<>();
		for (String id : order) {
			out.add(new Section(id, inSectionOrder(byGoal.get(id))));
		}
		if (!general.isEmpty()) {
			out.add(new Section(null, inSectionOrder(general)));
		}
		return out;
	}

	private static List<MemoryEntry> inSectionOrder(List<MemoryEntry> l) {
		List<MemoryEntry> out = new ArrayList<>(l);
		out.sort(Comparator.comparingInt(MemoryIndex::pin).thenComparing(Comparator.comparingLong(MemoryEntry::updated).reversed()));
		return List.copyOf(out);
	}

	private static int pin(MemoryEntry e) {
		String k = kindOf(e);
		return PLAN.equals(k) ? 0 : SUMMARY.equals(k) ? 1 : 2;
	}

	/** Lower case without accents ("Élément" -> "element"), for accent-insensitive search. */
	public static String fold(String s) {
		String n = Normalizer.normalize(s, Normalizer.Form.NFD);
		return MARKS.matcher(n).replaceAll("").replace("œ", "oe").replace("Œ", "oe").replace("æ", "ae").replace("Æ", "ae").toLowerCase(Locale.ROOT);
	}

	private static List<String> terms(String query) {
		List<String> out = new ArrayList<>();
		for (String t : SPACES.split(fold(query).trim())) {
			if (!t.isEmpty()) {
				out.add(t);
			}
		}
		return out;
	}

	/** Every search word appears in the title or the body (case and accents ignored). */
	private static boolean matches(MemoryEntry e, List<String> terms) {
		if (terms.isEmpty()) {
			return true;
		}
		String text = FOLDED.computeIfAbsent(e.id() + "@" + e.updated(), k -> fold(e.title() + "\n" + e.body()));
		for (String t : terms) {
			if (!text.contains(t)) {
				return false;
			}
		}
		return true;
	}

	/** The goal's text (its id when the Foreman does not know it), for a section header. */
	public static String goalText(String goalId) {
		ForemanState s = Foreman.state();
		Protocol.Goal g = s == null ? null : s.goals().get(goalId);
		if (g == null && s != null && s.goal() != null && goalId.equals(s.goal().id())) {
			g = s.goal();
		}
		return g == null || g.text().isBlank() ? goalId : g.text().replaceAll("\\s+", " ").trim();
	}

	public static Protocol.@Nullable GoalStatus goalStatus(String goalId) {
		ForemanState s = Foreman.state();
		Protocol.Goal g = s == null ? null : s.goals().get(goalId);
		if (g == null && s != null && s.goal() != null && goalId.equals(s.goal().id())) {
			g = s.goal();
		}
		return g == null ? null : g.status();
	}

	public static boolean isCurrentGoal(@Nullable String goalId) {
		ForemanState s = Foreman.state();
		return goalId != null && s != null && s.goal() != null && goalId.equals(s.goal().id());
	}

	// ------------------------------------------------------------------ scopes (archive shelves)

	/** Entries of a scope ({@link #ALL} = every scope), plan first, then newest first. */
	public static List<MemoryEntry> entries(@Nullable String scope) {
		refresh();
		if (scope == null || scope.isEmpty()) {
			return all;
		}
		List<MemoryEntry> out = new ArrayList<>();
		for (MemoryEntry e : all) {
			if (scope.equals(e.scope())) {
				out.add(e);
			}
		}
		return out;
	}

	/**
	 * Shelf order of a scope: live notes before archived ones, plans first, then the Foreman's order
	 * (creation order), so a note keeps its place on the archive shelf when it is updated.
	 */
	public static List<MemoryEntry> shelf(@Nullable String scope) {
		ForemanState s = Foreman.state();
		if (s == null) {
			return List.of();
		}
		if (s.revision() != shelfRevision) {
			SHELVES.clear();
			shelfRevision = s.revision();
		}
		return SHELVES.computeIfAbsent(scope == null ? "" : scope, k -> buildShelf(s, k));
	}

	private static final Map<String, List<MemoryEntry>> SHELVES = new HashMap<>();
	private static long shelfRevision = -1;

	private static List<MemoryEntry> buildShelf(ForemanState s, String scope) {
		List<MemoryEntry> out = new ArrayList<>();
		for (MemoryEntry e : s.memory().values()) {
			if (scope.isEmpty() || scope.equals(e.scope())) {
				out.add(e);
			}
		}
		out.sort(Comparator.comparingInt((MemoryEntry e) -> e.isArchived() ? 1 : 0).thenComparingInt(e -> isPlan(e) ? 0 : 1));
		return List.copyOf(out);
	}

	public static int count(@Nullable String scope) {
		refresh();
		if (scope == null || scope.isEmpty()) {
			return all.size();
		}
		return counts.getOrDefault(scope, 0);
	}

	/** The plan to open on: the current goal's live plan, else the newest live plan, else the newest plan. */
	public static @Nullable MemoryEntry plan() {
		refresh();
		ForemanState s = Foreman.state();
		String current = s == null || s.goal() == null ? null : s.goal().id();
		MemoryEntry live = null;
		MemoryEntry any = null;
		for (MemoryEntry e : all) {
			if (!isPlan(e)) {
				continue;
			}
			if (!e.isArchived() && current != null && Objects.equals(current, e.goalId())) {
				return e;
			}
			if (!e.isArchived() && live == null) {
				live = e;
			}
			if (any == null) {
				any = e;
			}
		}
		return live != null ? live : any;
	}

	/** Newest update time in a scope (0 = none). */
	public static long newest(@Nullable String scope) {
		long n = 0;
		for (MemoryEntry e : entries(scope)) {
			n = Math.max(n, e.updated());
		}
		return n;
	}

	public static String scopeLabel(@Nullable String scope) {
		if (scope == null || scope.isEmpty()) {
			return Tr.t("library.scope_all");
		}
		if (scope.equals("shared")) {
			return Tr.t("library.scope_shared");
		}
		return ReviewKit.agentName(scope);
	}
}
