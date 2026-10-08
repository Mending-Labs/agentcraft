package dev.agentcraft.client.ui;

import net.minecraft.client.resources.language.I18n;

/**
 * Translated UI text: keys live in assets/agentcraft/lang/{en_us,fr_fr}.json, under "agentcraft.".
 * Resolve at draw time, never in a static initializer: the language is loaded after the mod.
 */
public final class Tr {
	private Tr() {
	}

	/** The text for {@code key} ("agentcraft." is prepended), with %s / %1$s arguments filled in. */
	public static String t(String key, Object... args) {
		return I18n.get("agentcraft." + key, args);
	}
}
