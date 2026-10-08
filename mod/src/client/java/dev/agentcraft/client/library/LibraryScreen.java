package dev.agentcraft.client.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.console.TextFieldView;
import dev.agentcraft.client.console.TextKeys;
import dev.agentcraft.client.console.TextModel;
import dev.agentcraft.client.diff.ReviewKit;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.foreman.ForemanState;
import dev.agentcraft.client.foreman.Protocol;
import dev.agentcraft.client.foreman.Protocol.MemoryEntry;
import dev.agentcraft.client.library.MemoryIndex.Section;
import dev.agentcraft.client.library.MemoryIndex.Tab;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.TextUtil;
import dev.agentcraft.client.ui.Tr;
import dev.agentcraft.client.ui.UiStyle;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * The memory library: every memory entry (shared + per agent) in a two-pane reader. Left: a search
 * field over the list, the notes of the active tab (all live notes, one kind, or the archives) grouped
 * by goal (the current goal first, then the others newest first, then the general notes); in a goal,
 * its plan then its summary pinned, then newest first. Each row: kind chip, title, author face + name,
 * private mark, age, a quiet NEW tab on unread notes. Right: the selected entry rendered as markdown
 * (headings, lists, code, tables, quotes) with live task-status dots after task ids.
 *
 * <pre>
 * keys: Up/Down entry · Tab / 1-7 tab · / or Ctrl+F search · j k / wheel / PgUp PgDn scroll · c copy markdown · Esc close
 * search field: typing filters (title + body, case and accents ignored) · Enter keep · Esc clear, then leave
 * </pre>
 */
public final class LibraryScreen extends Screen {
	private static final int ROW_H = 39;
	private static final int HEAD_H = 17;
	private static final int FIELD_GAP = 4;

	private Tab tab;
	private @Nullable String selectedId;
	/** A note asked for at open (archive shelf / lectern / dev): shown even if it lives in another tab. */
	private boolean revealPending;
	private final TextModel query = new TextModel(120);
	private final TextFieldView field = new TextFieldView();
	private boolean searchFocused;
	private List<Section> sections = List.of();
	/** The notes in list order (the navigation order). */
	private List<MemoryEntry> entries = List.of();
	/** The list rows: section headers and notes, with their y in list space. */
	private List<Row> rows = List.of();
	private int listContentH;
	private long seenRevision = -1;
	private String builtKey = "";
	private @Nullable MdLayout body;
	private @Nullable String bodyKey;
	private float scroll;
	private float scrollTarget;
	private float listScroll;
	private long lastNanos;
	private boolean dragThumb;
	private double dragOffset;
	private @Nullable String flash;
	private long flashUntil;
	private final List<int[]> tabRects = new ArrayList<>();
	private final List<Tab> tabHits = new ArrayList<>();

	/** A list row: a goal header ({@code entry} null) or a note. */
	private record Row(@Nullable MemoryEntry entry, @Nullable Section section, int y, int h) {
	}

	// layout
	private int px;
	private int py;
	private int pw;
	private int ph;
	private int ix;
	private int iy;
	private int iw;
	private int ih;
	private int bodyY;
	private int bodyBottom;
	private int listTop;
	private int listW;
	private int readerX;
	private int readerW;
	private int textX;
	private int textW;
	private int textY;
	private int textH;

	/**
	 * @param tabName  a tab ("plans", "archives"...); anything else (null, "all", an archive shelf's scope) opens "all"
	 * @param memoryId the note to select (its tab is switched to when the note lives elsewhere), null = the first one
	 */
	public LibraryScreen(@Nullable String tabName, @Nullable String memoryId) {
		super(Component.translatable("agentcraft.library.title"));
		this.tab = Tab.parse(tabName);
		this.selectedId = memoryId;
		this.revealPending = memoryId != null;
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	public Tab tab() {
		return tab;
	}

	// ------------------------------------------------------------------ model

	private void refresh() {
		ForemanState s = Foreman.state();
		long rev = s == null ? 0 : s.revision();
		if (revealPending && s != null && selectedId != null && s.memory().containsKey(selectedId)) {
			MemoryEntry want = s.memory().get(selectedId);
			if (!tab.accepts(want)) {
				tab = want.isArchived() ? Tab.ARCHIVES : Tab.ALL;
			}
			revealPending = false;
		} else if (revealPending && s != null && s.hasData()) {
			// the note asked for does not exist (any more): fall back to the first one
			revealPending = false;
		}
		String key = tab.wire + "\u0000" + query.value();
		if (rev == seenRevision && key.equals(builtKey)) {
			return;
		}
		seenRevision = rev;
		builtKey = key;
		sections = MemoryIndex.sections(tab, query.value());
		List<MemoryEntry> flat = new ArrayList<>();
		List<Row> r = new ArrayList<>();
		int y = 0;
		for (Section sec : sections) {
			r.add(new Row(null, sec, y, HEAD_H));
			y += HEAD_H;
			for (MemoryEntry e : sec.entries()) {
				flat.add(e);
				r.add(new Row(e, sec, y, ROW_H));
				y += ROW_H;
			}
		}
		entries = List.copyOf(flat);
		rows = List.copyOf(r);
		listContentH = y;
		if (selectedId == null || entries.stream().noneMatch(e -> e.id().equals(selectedId))) {
			// keep a note asked for at open until the Foreman has sent it
			if (!(revealPending && selectedId != null)) {
				selectedId = entries.isEmpty() ? null : entries.get(0).id();
			}
		}
	}

	private @Nullable MemoryEntry selected() {
		if (selectedId == null) {
			return null;
		}
		for (MemoryEntry e : entries) {
			if (e.id().equals(selectedId)) {
				return e;
			}
		}
		return null;
	}

	private int selectedIndex() {
		for (int i = 0; i < entries.size(); i++) {
			if (entries.get(i).id().equals(selectedId)) {
				return i;
			}
		}
		return -1;
	}

	private @Nullable Row rowOf(String id) {
		for (Row r : rows) {
			if (r.entry() != null && r.entry().id().equals(id)) {
				return r;
			}
		}
		return null;
	}

	private void ensureBody() {
		MemoryEntry e = selected();
		if (e == null) {
			body = null;
			bodyKey = null;
			return;
		}
		// task ids in a note ("t3") get a live status dot: the plan reads as a progress report
		Set<String> taskIds = new HashSet<>();
		if (Foreman.state() != null) {
			taskIds.addAll(Foreman.state().tasks().keySet());
		}
		String key = e.id() + "@" + e.updated() + "#" + textW + ":" + taskIds.size();
		if (key.equals(bodyKey)) {
			return;
		}
		boolean sameEntry = bodyKey != null && bodyKey.startsWith(e.id() + "@");
		List<Markdown.Block> blocks = Markdown.parse(e.body());
		// the first heading usually repeats the title: the reader shows the title already
		if (!blocks.isEmpty() && blocks.get(0).type == Markdown.Type.H1 && norm(Markdown.plain(blocks.get(0).text)).equals(norm(e.title()))) {
			blocks = blocks.subList(1, blocks.size());
		}
		body = MdLayout.build(font, blocks, textW, taskIds);
		bodyKey = key;
		if (!sameEntry) {
			scroll = scrollTarget = 0;
		}
	}

	private final Map<String, String> excerpts = new HashMap<>();

	/** First line of prose of an entry (headings skipped), plain text, for the list. */
	private String excerpt(MemoryEntry e) {
		return excerpts.computeIfAbsent(e.id() + "@" + e.updated(), k -> {
			for (Markdown.Block b : Markdown.parse(e.body())) {
				switch (b.type) {
					case PARA, BULLET, NUMBER, TASK, QUOTE -> {
						String t = Markdown.plain(b.text).replaceAll("\\s+", " ").trim();
						if (!t.isEmpty() && !norm(t).equals(norm(e.title()))) {
							return t;
						}
					}
					default -> {
					}
				}
			}
			return "";
		});
	}

	private static String norm(String s) {
		return s.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9#]+", " ").trim();
	}

	private void select(int index) {
		if (entries.isEmpty()) {
			return;
		}
		int i = Math.max(0, Math.min(entries.size() - 1, index));
		selectedId = entries.get(i).id();
		revealPending = false;
		Row r = rowOf(selectedId);
		if (r == null) {
			return;
		}
		// the first note of a section brings its header into view too
		int y = isFirstOfSection(r) ? r.y() - HEAD_H : r.y();
		int lh = bodyBottom - listTop;
		if (y < listScroll) {
			listScroll = y;
		} else if (r.y() + ROW_H > listScroll + lh) {
			listScroll = r.y() + ROW_H - lh;
		}
	}

	private boolean isFirstOfSection(Row r) {
		return r.section() != null && !r.section().entries().isEmpty() && r.section().entries().get(0) == r.entry();
	}

	private void setTab(Tab t) {
		if (t == tab) {
			return;
		}
		tab = t;
		revealPending = false;
		listScroll = 0;
		refresh();
	}

	private void queryChanged() {
		// a pasted multi-line text searches as one line
		if (query.value().indexOf('\n') >= 0 || query.value().indexOf('\r') >= 0) {
			query.set(query.value().replaceAll("[\\r\\n]+", " "));
		}
		listScroll = 0;
		refresh();
	}

	// ------------------------------------------------------------------ layout

	@Override
	protected void init() {
		int margin = width >= 900 ? 16 : width >= 560 ? 10 : 6;
		pw = Math.min(width - 2 * margin, 1000);
		ph = Math.min(height - 2 * Math.max(6, margin - 2), 620);
		px = (width - pw) / 2;
		py = (height - ph) / 2;
		ix = px + 8;
		iy = py + 8;
		iw = pw - 16;
		ih = ph - 17;
		bodyY = iy + 42;
		bodyBottom = iy + ih - 17;
		listTop = bodyY + TextFieldView.BASE_H + FIELD_GAP;
		listW = Math.max(120, Math.min(290, Math.round(iw * 0.33f)));
		readerX = ix + listW + 6;
		readerW = ix + iw - readerX;
		textX = readerX + 11;
		// a comfortable measure: about 100 characters at most, however wide the screen
		textW = Math.min(readerW - 22 - 6, 600);
		textY = bodyY + 38;
		textH = bodyBottom - 6 - textY;
		bodyKey = null;
	}

	private int maxScroll() {
		return body == null ? 0 : Math.max(0, body.height - textH);
	}

	// ------------------------------------------------------------------ frame

	private void animate() {
		long now = System.nanoTime();
		float dt = lastNanos == 0 ? 0.016f : Math.min(0.1f, (now - lastNanos) / 1e9f);
		lastNanos = now;
		float k = 1 - (float) Math.exp(-dt * 16);
		scrollTarget = Math.max(0, Math.min(scrollTarget, maxScroll()));
		scroll += (scrollTarget - scroll) * k;
		if (Math.abs(scrollTarget - scroll) < 0.25f) {
			scroll = scrollTarget;
		}
	}

	private float snap(float v) {
		int s = Math.max(1, minecraft.getWindow().getGuiScale());
		return Math.round(v * s) / (float) s;
	}

	@Override
	public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		if (ReviewKit.blurBehind) {
			extractBlurredBackground(g);
		}
		g.fill(0, 0, width, height, UiStyle.withAlpha(UiStyle.WALNUT, 0x7A));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mx, int my, float a) {
		refresh();
		ensureBody();
		animate();
		Panels.panel(g, px, py, pw, ph);
		drawHeader(g);
		drawTabs(g, mx, my);
		drawSearch(g);
		drawList(g, mx, my);
		drawReader(g, mx, my);
		drawFooter(g);
		super.extractRenderState(g, mx, my, a);
	}

	private void drawHeader(GuiGraphicsExtractor g) {
		Panels.sprite(g, Kit.HEADER, ix, iy, iw, 14);
		Panels.sprite(g, Kit.icon("memory"), ix + 4, iy + 1, 12, 12);
		ReviewKit.bold(g, font, Tr.t("library.title"), ix + 20, iy + 3, ReviewKit.ink());
		int n = MemoryIndex.count(MemoryIndex.ALL);
		long newest = MemoryIndex.newest(MemoryIndex.ALL);
		String right = n == 0 ? Tr.t("library.empty") : Tr.t(n == 1 ? "library.notes_one" : "library.notes_many", n)
			+ (newest > 0 ? " · " + Tr.t("library.updated", ReviewKit.ago(newest)) : "");
		ForemanState s = Foreman.state();
		if (s != null && s.isStale()) {
			right = Tr.t("library.offline_last_known", right);
		}
		g.text(font, right, ix + iw - 5 - font.width(right), iy + 3, ReviewKit.muted(), false);
	}

	private void drawTabs(GuiGraphicsExtractor g, int mx, int my) {
		tabRects.clear();
		tabHits.clear();
		int y = iy + 18;
		int x = ix;
		int edge = UiStyle.color("palette.ui.panel_edge");
		g.fill(ix, y + 19, ix + iw, y + 20, edge);
		for (Tab t : Tab.values()) {
			boolean active = t == tab;
			String label = t.label();
			String count = String.valueOf(MemoryIndex.count(t));
			int w = 12 + font.width(label) + 5 + font.width(count);
			if (x + w > ix + iw) {
				break;
			}
			int ty = active ? y : y + 2;
			Panels.sprite(g, active ? Kit.TAB_ACTIVE : Kit.TAB_INACTIVE, x, ty, w, active ? 20 : 18);
			int tx = x + 6;
			int textY0 = y + 7;
			g.text(font, label, tx, textY0, active ? ReviewKit.ink() : ReviewKit.muted(), false);
			tx += font.width(label) + 5;
			g.text(font, count, tx, textY0, active ? ReviewKit.muted() : UiStyle.color("paper.disabled"), false);
			tabRects.add(new int[] {x, y, w, 20});
			tabHits.add(t);
			x += w + 2;
		}
	}

	private TextFieldView.Style searchStyle() {
		String hint = query.isEmpty() ? null : String.valueOf(entries.size());
		return new TextFieldView.Style(null, UiStyle.BRASS, Tr.t(searchFocused ? "library.search_placeholder_focused" : "library.search_placeholder"),
			null, hint, ReviewKit.muted(), 1);
	}

	private void drawSearch(GuiGraphicsExtractor g) {
		field.draw(g, font, query, ix, bodyY, listW, searchFocused, searchStyle());
	}

	private void drawList(GuiGraphicsExtractor g, int mx, int my) {
		int x = ix;
		int w = listW;
		int top = listTop;
		int h = bodyBottom - top;
		int content = listContentH;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, content - h)));
		int muted = ReviewKit.muted();
		if (entries.isEmpty()) {
			String m = Tr.t(!query.isEmpty() ? "library.no_match" : tab == Tab.ALL ? "library.no_notes" : "library.no_notes_scope");
			g.text(font, TextUtil.ellipsize(font, m, w - 12), x + 6, top + 8, muted, false);
			return;
		}
		g.enableScissor(x, top, x + w, top + h);
		for (Row row : rows) {
			int y = top + row.y() - Math.round(listScroll);
			if (y + row.h() < top || y > top + h) {
				continue;
			}
			if (row.entry() == null) {
				drawSectionHeader(g, row.section(), x, y, w);
			} else {
				drawEntry(g, row.entry(), x, y, w, mx, my, top, h);
			}
		}
		g.disableScissor();
		if (content > h) {
			int thumbH = Math.max(10, h * h / content);
			int ty = top + Math.round((h - thumbH) * (listScroll / Math.max(1, content - h)));
			g.fill(x + w - 2, ty, x + w, ty + thumbH, UiStyle.color("palette.ui.thumb"));
		}
	}

	/** A goal's header: its text (or "General") and, on the right, its status and the number of notes shown. */
	private void drawSectionHeader(GuiGraphicsExtractor g, @Nullable Section sec, int x, int y, int w) {
		if (sec == null) {
			return;
		}
		g.fill(x, y + 1, x + w, y + HEAD_H - 2, UiStyle.color("palette.ui.panel_shade"));
		boolean current = MemoryIndex.isCurrentGoal(sec.goalId());
		if (current) {
			g.fill(x, y + 1, x + 2, y + HEAD_H - 2, UiStyle.BRASS);
		}
		StringBuilder right = new StringBuilder();
		if (sec.goalId() != null) {
			Protocol.GoalStatus st = MemoryIndex.goalStatus(sec.goalId());
			if (st != null && st != Protocol.GoalStatus.UNKNOWN) {
				right.append(Tr.t("console.goal_status_" + st.wire()));
			}
		}
		right.append(right.isEmpty() ? "" : " · ").append(sec.entries().size());
		String r = right.toString();
		int rw = font.width(r);
		g.text(font, r, x + w - 6 - rw, y + 5, ReviewKit.muted(), false);
		String title = sec.goalId() == null ? Tr.t("library.section_general") : MemoryIndex.goalText(sec.goalId());
		int tx = x + 7;
		ReviewKit.bold(g, font, TextUtil.ellipsize(font, title, x + w - 12 - rw - tx), tx, y + 5, current ? ReviewKit.ink() : ReviewKit.muted());
	}

	private void drawEntry(GuiGraphicsExtractor g, MemoryEntry e, int x, int y, int w, int mx, int my, int top, int h) {
		int muted = ReviewKit.muted();
		boolean sel = e.id().equals(selectedId);
		boolean hov = mx >= x && mx < x + w && my >= y && my < y + ROW_H && my >= top && my < top + h;
		if (sel) {
			g.fill(x, y, x + w, y + ROW_H - 1, UiStyle.color("palette.ui.panel_hi"));
			g.fill(x, y, x + 2, y + ROW_H - 1, UiStyle.CLAY);
		} else if (hov) {
			g.fill(x, y, x + w, y + ROW_H - 1, UiStyle.color("palette.ui.panel_shade"));
		}
		int tx = x + 7;
		int right = x + w - 5;
		if (MemoryIndex.isUnread(e) && !sel) {
			// written since you last read it: a quiet clay "NEW" tab (not a status dot)
			String nw = Tr.t("library.chip_new");
			int nwW = font.width(nw) + 6;
			ReviewKit.chip(g, font, nw, right - nwW, y + 3, ReviewKit.mix(UiStyle.color("palette.ui.panel"), UiStyle.CLAY, 0.2f), UiStyle.color(
				"paper.link"));
			right -= nwW + 4;
		}
		tx += kindChip(g, e, tx, y + 3);
		g.text(font, TextUtil.ellipsize(font, e.title(), right - tx), tx, y + 5, ReviewKit.ink(), false);
		// author face + name · private · age
		String author = e.author() != null ? e.author() : e.scope().equals("shared") ? null : e.scope();
		int ay = y + 16;
		int ax = x + 7;
		if (author != null) {
			ReviewKit.face(g, font, author, ax, ay - 1, 8);
			ax += 11;
			String name = ReviewKit.agentName(author);
			g.text(font, name, ax, ay, ReviewKit.agentInk(author), false);
			ax += font.width(name);
		}
		StringBuilder meta = new StringBuilder();
		if (!e.scope().equals("shared")) {
			meta.append(author != null ? " · " : "").append(Tr.t("library.private"));
		}
		String age = ReviewKit.ago(e.updated());
		if (!age.isEmpty()) {
			meta.append(meta.isEmpty() && author == null ? "" : " · ").append(age);
		}
		g.text(font, TextUtil.ellipsize(font, meta.toString(), x + w - 5 - ax), ax, ay, muted, false);
		g.text(font, TextUtil.ellipsize(font, excerpt(e), w - 13), x + 7, y + 27, muted, false);
		g.fill(x + 4, y + ROW_H - 1, x + w - 4, y + ROW_H, UiStyle.color("palette.ui.panel_shade"));
	}

	/** The note's kind chip (plan, report, review, summary, decision; none for a plain note). Returns the room it took. */
	private int kindChip(GuiGraphicsExtractor g, MemoryEntry e, int x, int y) {
		String kind = MemoryIndex.kindOf(e);
		int panel = UiStyle.color("palette.ui.panel");
		int bg;
		int fg;
		switch (kind) {
			case MemoryIndex.PLAN -> {
				bg = ReviewKit.mix(panel, UiStyle.BRASS, 0.32f);
				fg = UiStyle.color("paper.path");
			}
			case MemoryIndex.REPORT -> {
				bg = ReviewKit.mix(panel, UiStyle.TEAL, 0.24f);
				fg = UiStyle.color("paper.hunk");
			}
			case MemoryIndex.REVIEW -> {
				bg = ReviewKit.mix(panel, UiStyle.color("paper.muted"), 0.3f);
				fg = ReviewKit.ink();
			}
			case MemoryIndex.SUMMARY -> {
				bg = ReviewKit.mix(panel, UiStyle.SAGE, 0.34f);
				fg = UiStyle.color("paper.add_fg");
			}
			case MemoryIndex.DECISION -> {
				bg = ReviewKit.mix(panel, UiStyle.CLAY_DARK, 0.3f);
				fg = UiStyle.color("paper.link");
			}
			default -> {
				return 0;
			}
		}
		return ReviewKit.chip(g, font, Tr.t("library.chip_" + kind), x, y, bg, fg) + 4;
	}

	private void drawReader(GuiGraphicsExtractor g, int mx, int my) {
		int x = readerX;
		int y = bodyY;
		int w = readerW;
		int h = bodyBottom - bodyY;
		// a sheet of paper: highlight paper, hairline edge, soft bottom shadow
		g.fill(x, y, x + w, y + h, UiStyle.color("palette.ui.panel_hi"));
		ReviewKit.outline(g, x, y, w, h, UiStyle.color("palette.ui.panel_edge"));
		g.fill(x + 1, y + h, x + w, y + h + 1, UiStyle.withAlpha(UiStyle.color("palette.ui.paper_deep"), 0xA0));
		MemoryEntry e = selected();
		int muted = ReviewKit.muted();
		if (e != null) {
			MemoryIndex.markSeen(e);
		}
		if (e == null) {
			String m1 = Tr.t("library.no_memory");
			String m2 = Tr.t("library.no_memory_hint");
			g.text(font, m1, x + (w - font.width(m1)) / 2, y + h / 2 - 10, ReviewKit.ink(), false);
			String m = TextUtil.ellipsize(font, m2, w - 20);
			g.text(font, m, x + (w - font.width(m)) / 2, y + h / 2 + 2, muted, false);
			return;
		}
		// title + meta (fixed), then the scrolling body
		int tx = textX;
		int ty = y + 8;
		String title = e.title();
		int titleW = textW;
		String scopeText = e.scope().equals("shared") ? Tr.t("library.shared") : Tr.t("library.private_to", ReviewKit.agentName(e.scope()));
		ReviewKit.bold(g, font, TextUtil.ellipsize(font, title, titleW), tx, ty, ReviewKit.ink());
		int my0 = ty + 13;
		int ax = tx;
		if (e.author() != null) {
			ReviewKit.face(g, font, e.author(), ax, my0 - 1, 8);
			ax += 11;
			String name = ReviewKit.agentName(e.author());
			g.text(font, name, ax, my0, ReviewKit.agentInk(e.author()), false);
			ax += font.width(name) + 4;
		}
		String meta = Tr.t("library.updated", ReviewKit.ago(e.updated())) + " · " + scopeText + (e.isArchived() ? " · " + Tr.t("library.archived")
			: "");
		g.text(font, TextUtil.ellipsize(font, meta, tx + textW - ax), ax, my0, muted, false);
		Panels.divider(g, tx, my0 + 11, textW + 6);
		if (body == null) {
			return;
		}
		float sy = snap(scroll);
		int base = (int) Math.floor(sy);
		float frac = sy - base;
		g.enableScissor(tx - 4, textY, x + w - 8, textY + textH);
		g.pose().pushMatrix();
		g.pose().translate(0, -frac);
		body.draw(g, font, tx, textY, base, textH, this::taskFamily);
		g.pose().popMatrix();
		g.disableScissor();
		// soft paper fades where the text runs under the edges
		int hi = UiStyle.color("palette.ui.panel_hi");
		if (scroll > 0.5f) {
			g.fillGradient(tx - 4, textY, x + w - 9, textY + 7, hi, UiStyle.withAlpha(hi, 0));
		}
		if (scroll < maxScroll() - 0.5f) {
			g.fillGradient(tx - 4, textY + textH - 9, x + w - 9, textY + textH, UiStyle.withAlpha(hi, 0), hi);
		}
		if (body.height > textH) {
			int sbx = x + w - 8;
			Panels.sprite(g, Kit.SCROLL_TRACK, sbx, textY, 6, textH);
			int thumbH = Math.max(10, textH * textH / body.height);
			int thy = textY + Math.round((textH - thumbH) * (scroll / Math.max(1, maxScroll())));
			boolean hov = mx >= sbx && mx < sbx + 6 && my >= textY && my < textY + textH;
			Panels.sprite(g, hov || dragThumb ? Kit.SCROLL_THUMB_HOVER : Kit.SCROLL_THUMB, sbx, thy, 6, thumbH);
			if (thumbH >= 10) {
				Panels.sprite(g, Kit.SCROLL_GRIP, sbx + 2, thy + thumbH / 2 - 1, 2, 3);
			}
		}
	}

	private @Nullable String taskFamily(String taskId) {
		ForemanState s = Foreman.state();
		Protocol.Task t = s == null ? null : s.task(taskId);
		if (t == null) {
			return null;
		}
		return dev.agentcraft.client.ui.StatusMap.task(s, t);
	}

	private void drawFooter(GuiGraphicsExtractor g) {
		int y = iy + ih - 12;
		long now = System.currentTimeMillis();
		if (flash != null && now < flashUntil) {
			g.text(font, flash, ix + iw - font.width(flash), y + 2, UiStyle.color("paper.add_fg"), false);
		}
		String esc = Tr.t("library.key_esc");
		String[][] hints = searchFocused
			? new String[][] {{Tr.t("library.key_enter"), Tr.t("library.hint_search_done")}, {esc, Tr.t(query.isEmpty() ? "library.hint_search_leave"
				: "library.hint_search_clear")}, {"↑ ↓", Tr.t("library.hint_note")}, {"Tab", Tr.t("library.hint_scope")}}
			: new String[][] {{"↑ ↓", Tr.t("library.hint_note")}, {"Tab", Tr.t("library.hint_scope")}, {"/", Tr.t("library.hint_search")}, {"j k", Tr.t(
				"library.hint_scroll")}, {"c", Tr.t("library.hint_copy")}, {esc, Tr.t(query.isEmpty() ? "library.hint_close" : "library.hint_search_clear")}};
		int x = ix;
		int limit = flash != null && now < flashUntil ? ix + iw - font.width(flash) - 10 : ix + iw;
		for (String[] h : hints) {
			int w = ReviewKit.hintWidth(font, h[0], h[1]);
			if (x + w > limit) {
				break;
			}
			ReviewKit.hint(g, font, h[0], h[1], x, y);
			x += w + 10;
		}
	}

	// ------------------------------------------------------------------ input

	private void scrollBy(float px) {
		scrollTarget = Math.max(0, Math.min(maxScroll(), scrollTarget + px));
	}

	private void focusSearch() {
		searchFocused = true;
		query.selectAll();
		query.touch();
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		int k = e.input();
		boolean shift = e.hasShiftDown();
		int page = Math.max(MdLayout.LINE_H, textH - 2 * MdLayout.LINE_H);
		if (searchFocused) {
			return searchKey(e, k, shift, page);
		}
		if (e.isEscape()) {
			if (!query.isEmpty()) {
				query.clear();
				queryChanged();
				return true;
			}
			onClose();
			return true;
		}
		if (TextKeys.ctrl(e, 'f', InputConstants.KEY_F)) {
			focusSearch();
			return true;
		}
		switch (k) {
			case InputConstants.KEY_DOWN -> select(selectedIndex() + 1);
			case InputConstants.KEY_UP -> select(selectedIndex() - 1);
			case InputConstants.KEY_J -> scrollBy(MdLayout.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_K -> scrollBy(-MdLayout.LINE_H * (shift ? 5 : 1));
			case InputConstants.KEY_PAGEDOWN -> scrollBy(page);
			case InputConstants.KEY_PAGEUP -> scrollBy(-page);
			case InputConstants.KEY_SPACE -> scrollBy(shift ? -page : page);
			case InputConstants.KEY_HOME -> scrollTarget = 0;
			case InputConstants.KEY_END -> scrollTarget = maxScroll();
			case InputConstants.KEY_G -> scrollTarget = shift ? maxScroll() : 0;
			case InputConstants.KEY_TAB -> cycleTab(shift ? -1 : 1);
			case InputConstants.KEY_C -> copy();
			default -> {
				if (k >= InputConstants.KEY_1 && k <= InputConstants.KEY_1 + 8) {
					int i = k - InputConstants.KEY_1;
					if (i < Tab.values().length) {
						setTab(Tab.values()[i]);
					}
					return true;
				}
				return super.keyPressed(e);
			}
		}
		return true;
	}

	/** Keys while the search field has the focus: editing keys go to the field, letters and digits are typed (charTyped). */
	private boolean searchKey(KeyEvent e, int k, boolean shift, int page) {
		if (e.isEscape()) {
			if (!query.isEmpty()) {
				query.clear();
				queryChanged();
			} else {
				searchFocused = false;
			}
			return true;
		}
		if (TextKeys.isEnter(e)) {
			searchFocused = false;
			return true;
		}
		switch (k) {
			case InputConstants.KEY_DOWN -> {
				select(selectedIndex() + 1);
				return true;
			}
			case InputConstants.KEY_UP -> {
				select(selectedIndex() - 1);
				return true;
			}
			case InputConstants.KEY_TAB -> {
				cycleTab(shift ? -1 : 1);
				return true;
			}
			case InputConstants.KEY_PAGEDOWN -> {
				scrollBy(page);
				return true;
			}
			case InputConstants.KEY_PAGEUP -> {
				scrollBy(-page);
				return true;
			}
			default -> {
			}
		}
		if (TextKeys.ctrl(e, 'f', InputConstants.KEY_F)) {
			query.selectAll();
			return true;
		}
		String before = query.value();
		if (TextKeys.handle(e, query)) {
			if (!before.equals(query.value())) {
				queryChanged();
			}
			return true;
		}
		// every other key is text (typed through charTyped), never a library shortcut
		return true;
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		int cp = e.codepoint();
		if (!searchFocused) {
			// "/" (whatever the keyboard layout) opens the search; other characters are shortcuts handled by keyPressed
			if (cp == '/') {
				focusSearch();
				return true;
			}
			return false;
		}
		if (cp < 32) {
			return true;
		}
		query.insert(e.codepointAsString());
		queryChanged();
		return true;
	}

	private void cycleTab(int dir) {
		Tab[] all = Tab.values();
		setTab(all[Math.floorMod(tab.ordinal() + dir, all.length)]);
	}

	private void copy() {
		MemoryEntry e = selected();
		if (e == null) {
			return;
		}
		minecraft.keyboardHandler.setClipboard(e.body());
		flash = Tr.t("library.copied", TextUtil.ellipsize(font, e.title(), 140));
		flashUntil = System.currentTimeMillis() + 2500;
	}

	@Override
	public boolean mouseClicked(MouseButtonEvent e, boolean doubleClick) {
		double mx = e.x();
		double my = e.y();
		if (e.button() == 0) {
			int fh = field.height(font, query, listW, searchStyle());
			if (mx >= ix && mx < ix + listW && my >= bodyY && my < bodyY + fh) {
				searchFocused = true;
				int at = field.hit(font, query, ix, bodyY, listW, searchStyle(), mx, my);
				if (at >= 0) {
					query.moveTo(at, false);
				}
				query.touch();
				return true;
			}
			searchFocused = false;
			for (int i = 0; i < tabRects.size(); i++) {
				int[] r = tabRects.get(i);
				if (mx >= r[0] && mx < r[0] + r[2] && my >= r[1] && my < r[1] + r[3]) {
					setTab(tabHits.get(i));
					return true;
				}
			}
			if (mx >= ix && mx < ix + listW && my >= listTop && my < bodyBottom) {
				double ly = my - listTop + listScroll;
				for (Row r : rows) {
					if (r.entry() != null && ly >= r.y() && ly < r.y() + r.h()) {
						select(entries.indexOf(r.entry()));
						break;
					}
				}
				return true;
			}
			int sbx = readerX + readerW - 8;
			if (body != null && body.height > textH && mx >= sbx && mx < sbx + 6 && my >= textY && my < textY + textH) {
				int thumbH = Math.max(10, textH * textH / body.height);
				float thy = textY + (textH - thumbH) * (scroll / Math.max(1, maxScroll()));
				if (my >= thy && my < thy + thumbH) {
					dragThumb = true;
					dragOffset = my - thy;
				} else {
					scrollTarget = (float) ((my - textY - thumbH / 2.0) / Math.max(1, textH - thumbH)) * maxScroll();
				}
				return true;
			}
		}
		return super.mouseClicked(e, doubleClick);
	}

	@Override
	public boolean mouseReleased(MouseButtonEvent e) {
		dragThumb = false;
		return super.mouseReleased(e);
	}

	@Override
	public boolean mouseDragged(MouseButtonEvent e, double dx, double dy) {
		if (dragThumb && body != null) {
			int thumbH = Math.max(10, textH * textH / body.height);
			float f = (float) ((e.y() - dragOffset - textY) / Math.max(1, textH - thumbH));
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), f * maxScroll()));
			return true;
		}
		return super.mouseDragged(e, dx, dy);
	}

	@Override
	public boolean mouseScrolled(double mx, double my, double sx, double sy) {
		if (mx >= ix && mx < ix + listW && my >= listTop && my < bodyBottom) {
			listScroll -= (float) (sy * ROW_H);
			return true;
		}
		scrollBy((float) (-sy * MdLayout.LINE_H * 3));
		return true;
	}

	// ------------------------------------------------------------------ dev / QA

	JsonObject stateJson() {
		refresh();
		ensureBody();
		JsonObject o = new JsonObject();
		o.addProperty("tab", tab.wire);
		o.addProperty("query", query.value());
		o.addProperty("searchFocused", searchFocused);
		o.addProperty("selected", selectedId);
		o.addProperty("entries", entries.size());
		o.addProperty("scroll", scroll);
		o.addProperty("maxScroll", maxScroll());
		o.addProperty("bodyHeight", body == null ? 0 : body.height);
		JsonArray secs = new JsonArray();
		for (Section sec : sections) {
			JsonObject so = new JsonObject();
			so.addProperty("goalId", sec.goalId());
			so.addProperty("title", sec.goalId() == null ? Tr.t("library.section_general") : MemoryIndex.goalText(sec.goalId()));
			JsonArray list = new JsonArray();
			for (MemoryEntry e : sec.entries()) {
				JsonObject j = new JsonObject();
				j.addProperty("id", e.id());
				j.addProperty("title", e.title());
				j.addProperty("scope", e.scope());
				j.addProperty("kind", MemoryIndex.kindOf(e));
				j.addProperty("archived", e.isArchived());
				list.add(j);
			}
			so.add("list", list);
			secs.add(so);
		}
		o.add("sections", secs);
		JsonObject tabs = new JsonObject();
		for (Tab t : Tab.values()) {
			tabs.addProperty(t.wire, MemoryIndex.count(t));
		}
		o.add("tabs", tabs);
		return o;
	}

	void applyDev(@Nullable String tabOpt, @Nullable String memoryId, @Nullable Float scrollPx, @Nullable String queryOpt) {
		if (tabOpt != null) {
			setTab(Tab.parse(tabOpt));
		}
		if (queryOpt != null) {
			query.set(queryOpt);
			queryChanged();
		}
		if (memoryId != null) {
			selectedId = memoryId;
			revealPending = true;
			seenRevision = -1;
			refresh();
		}
		ensureBody();
		if (scrollPx != null) {
			scrollTarget = scroll = Math.max(0, Math.min(maxScroll(), scrollPx));
		}
	}
}
