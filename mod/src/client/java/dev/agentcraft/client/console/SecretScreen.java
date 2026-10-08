package dev.agentcraft.client.console;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agentcraft.client.console.ConsoleLog.Tone;
import dev.agentcraft.client.foreman.Foreman;
import dev.agentcraft.client.hud.UiBits;
import dev.agentcraft.client.ui.Kit;
import dev.agentcraft.client.ui.Panels;
import dev.agentcraft.client.ui.Tr;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.network.chat.Component;
import org.jspecify.annotations.Nullable;

/**
 * Masked input for one secret ({@code /secret set NAME}): the value is shown as dots, never goes
 * through the console line or its history, cannot be copied out, and is sent once to the Foreman,
 * which stores it encrypted for the user's account (secrets.ts). Esc goes back to the console.
 */
public final class SecretScreen extends Screen {
	private static final int W = 300;
	private final String name;
	/** "claude" / "codex": links an AI subscription (/compte) instead of storing a vault secret */
	private final @Nullable String engine;
	private final TextModel value;
	private boolean sending;
	private @Nullable String error;

	public SecretScreen(String name) {
		this(name, null);
	}

	private SecretScreen(String name, @Nullable String engine) {
		super(engine != null ? Component.translatable("agentcraft.console.account_title", name) : Component.translatable("agentcraft.console.secret_title", name));
		this.name = name;
		this.engine = engine;
		// a Codex auth.json is a few kB
		this.value = new TextModel(engine != null ? 16384 : 8192);
	}

	/** The masked field for /compte claude|codex. */
	public static SecretScreen account(String engine) {
		return new SecretScreen(engine.equals("codex") ? "Codex" : "Claude", engine);
	}

	private String title() {
		return engine != null ? Tr.t("console.account_title", name) : Tr.t("console.secret_title", name);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}

	@Override
	public void onClose() {
		value.clear();
		ConsoleFeature.open("", false);
	}

	@Override
	public boolean keyPressed(KeyEvent e) {
		if (e.isEscape()) {
			onClose();
			return true;
		}
		if (sending) {
			return true;
		}
		if (TextKeys.isEnter(e)) {
			submit();
			return true;
		}
		// nothing leaves the field: no copy, no cut
		if (e.isCopy() || e.isCut() || TextKeys.ctrl(e, 'c', InputConstants.KEY_C) || TextKeys.ctrl(e, 'x', InputConstants.KEY_X)) {
			return true;
		}
		error = null;
		return TextKeys.handle(e, value) || super.keyPressed(e);
	}

	@Override
	public boolean charTyped(CharacterEvent e) {
		if (!sending && e.codepoint() >= 32) {
			value.insert(e.codepointAsString());
			error = null;
		}
		return true;
	}

	private void submit() {
		String v = value.value().strip();
		if (v.isEmpty()) {
			error = Tr.t("console.secret_empty");
			return;
		}
		sending = true;
		(engine != null ? Foreman.setAccount(engine, v) : Foreman.setSecret(name, v)).whenComplete((ack, t) -> Minecraft.getInstance().execute(() -> {
			sending = false;
			if (t == null && ack != null && ack.ok()) {
				value.clear();
				ConsoleLog.add(Tone.OK, engine != null ? Tr.t("console.account_linked", name) : Tr.t("console.secret_stored", name));
				onClose();
			} else {
				error = t != null ? t.getMessage() : ack != null && ack.error() != null ? ack.error() : Tr.t("console.secret_failed");
			}
		}));
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float a) {
		int w = Math.min(W, width - 20);
		int h = engine != null ? 118 : 104;
		int x = (width - w) / 2;
		int y = (height - h) / 2;
		Panels.panel(g, x, y, w, h);
		Kit.Padding p = Kit.padding("panel_paper");
		int ix = x + p.left();
		int iw = w - p.left() - p.right();
		int cy = y + p.top();
		Panels.header(g, font, title(), ix, cy, iw);
		cy += 20;
		if (engine != null) {
			g.text(font, Tr.t("console.account_explain_" + engine), ix, cy, UiBits.muted(), false);
			cy += 12;
			g.text(font, Tr.t("console.account_explain_server"), ix, cy, UiBits.muted(), false);
			cy += 14;
		} else {
			g.text(font, Tr.t("console.secret_explain"), ix, cy, UiBits.muted(), false);
			cy += 14;
		}
		Panels.sprite(g, Kit.TEXT_FIELD_FOCUSED, ix, cy, iw, 18);
		String dots = "•".repeat(Math.min(value.length(), (iw - 16) / font.width("•")));
		boolean caret = (System.currentTimeMillis() / 500) % 2 == 0 && !sending;
		g.text(font, dots + (caret ? "_" : ""), ix + 6, cy + 5, UiBits.ink(), false);
		String count = Tr.t("console.secret_length", value.length());
		g.text(font, count, ix + iw - 6 - font.width(count), cy + 5, UiBits.muted(), false);
		cy += 24;
		if (error != null) {
			g.text(font, error, ix, cy, UiBits.errorText(), false);
		} else if (sending) {
			g.text(font, Tr.t("console.secret_sending") + "…", ix, cy, UiBits.muted(), false);
		} else {
			UiBits.hints(g, font, ix, cy - 2, false, Tr.t("console.key_enter"), Tr.t("console.secret_save"), Tr.t("console.key_esc"), Tr.t("console.secret_cancel"));
		}
		super.extractRenderState(g, mouseX, mouseY, a);
	}
}
