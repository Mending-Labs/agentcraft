package dev.agentcraft.client.foreman;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.client.ClientEnv;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.jspecify.annotations.Nullable;

/**
 * A shared Foreman to connect to instead of the local one: {@code AGENTCRAFT_FOREMAN_URL} +
 * {@code AGENTCRAFT_TOKEN}, else {@code <AGENTCRAFT_HOME or ~/.agentcraft>/remote.json}
 * ({@code {"url": "ws://host:7878", "token": "acu_..."}}). The token is the member's own; it is
 * sent as a header, never shown.
 */
public record Remote(URI uri, @Nullable String token) {
	public static @Nullable Remote find() {
		String url = ClientEnv.raw("AGENTCRAFT_FOREMAN_URL");
		String token = ClientEnv.raw("AGENTCRAFT_TOKEN");
		if (url == null) {
			String home = ClientEnv.raw("AGENTCRAFT_HOME");
			Path file = (home != null ? Path.of(home) : Path.of(System.getProperty("user.home"), ".agentcraft")).resolve("remote.json");
			if (!Files.isRegularFile(file)) {
				return null;
			}
			try {
				JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
				url = o.has("url") ? o.get("url").getAsString().trim() : null;
				if (token == null && o.has("token")) {
					token = o.get("token").getAsString().trim();
				}
			} catch (Exception e) {
				AgentCraft.LOGGER.warn("ignoring {}: {}", file, e.getMessage());
				return null;
			}
		}
		if (url == null || url.isBlank()) {
			return null;
		}
		try {
			URI uri = URI.create(url);
			if (!"ws".equals(uri.getScheme()) && !"wss".equals(uri.getScheme())) {
				AgentCraft.LOGGER.warn("shared Foreman URL must start with ws:// or wss:// ({})", url);
				return null;
			}
			return new Remote(uri, token == null || token.isBlank() ? null : token);
		} catch (IllegalArgumentException e) {
			AgentCraft.LOGGER.warn("bad shared Foreman URL {}: {}", url, e.getMessage());
			return null;
		}
	}
}
