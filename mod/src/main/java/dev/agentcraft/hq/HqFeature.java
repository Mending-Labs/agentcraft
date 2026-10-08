package dev.agentcraft.hq;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.agentcraft.AgentCraft;
import dev.agentcraft.command.AgentCraftCommands;
import dev.agentcraft.layout.Anchor;
import dev.agentcraft.layout.AnchorNames;
import dev.agentcraft.layout.Anchors;
import dev.agentcraft.world.HqWorld;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * HQ feature (common side): {@code /agentcraft hq [builder] [force]} builds the HQ and publishes its
 * anchors. The studio builder keeps cells the player changed since its last build; {@code force}
 * resets them too.
 */
public final class HqFeature {
	private HqFeature() {
	}

	/** The report of the last build (for QA: {@code dev.state.hq.lastBuild}). */
	private static volatile @Nullable String lastReport;
	/** The full report of the last build (its chat message for {@code /agentcraft hq}). */
	private static volatile HqBuilder.@Nullable Report lastBuild;

	public static @Nullable String lastReport() {
		return lastReport;
	}

	public static void init() {
		HqBuilders.register(new TestRoomBuilder());
		HqBuilders.register(new StudioHqBuilder());
		HqBuilders.setDefault(StudioHqBuilder.ID);
		// A fresh HQ world (no saved layout yet) gets the default HQ built before the player joins, so
		// the first launch walks straight into it. AGENTCRAFT_HQ_AUTOBUILD=0 turns this off.
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			if (!HqWorld.isHq(server) || !Anchors.current().isEmpty() || !autoBuild()) {
				return;
			}
			HqBuilder builder = HqBuilders.get(HqBuilders.defaultId());
			if (builder != null) {
				try {
					buildAndPublish(server.overworld(), builder, HqBuilder.Options.DEFAULT);
					AgentCraft.LOGGER.info("Fresh HQ world: built the default HQ '{}'", builder.id());
				} catch (RuntimeException e) {
					AgentCraft.LOGGER.error("Auto-building the HQ failed (run /agentcraft hq)", e);
				}
			}
		});
		AgentCraftCommands.sub(root -> root.then(Commands.literal("hq")
			.executes(ctx -> build(ctx, HqBuilders.defaultId(), false))
			.then(Commands.literal("force").executes(ctx -> build(ctx, HqBuilders.defaultId(), true)))
			.then(Commands.argument("builder", StringArgumentType.word())
				.suggests((ctx, b) -> {
					HqBuilders.ids().forEach(b::suggest);
					return b.buildFuture();
				})
				.executes(ctx -> build(ctx, StringArgumentType.getString(ctx, "builder"), false))
				.then(Commands.literal("force").executes(ctx -> build(ctx, StringArgumentType.getString(ctx, "builder"), true))))));
	}

	private static boolean autoBuild() {
		String v = System.getProperty("agentcraft.hq.autobuild");
		if (v == null) {
			v = System.getenv("AGENTCRAFT_HQ_AUTOBUILD");
		}
		return v == null || !(v.trim().equals("0") || v.trim().equalsIgnoreCase("false") || v.trim().equalsIgnoreCase("off"));
	}

	/**
	 * Building rewrites a large area of terrain and moves the world spawn, so it only runs in the
	 * AgentCraft HQ world unless AGENTCRAFT_HQ_ANYWORLD=1 (-Dagentcraft.hq.anyworld=1) opts in, and
	 * never in a Hardcore world.
	 */
	private static @Nullable Component refusal(CommandSourceStack source) {
		var server = source.getServer();
		if (server.getWorldData().isHardcore()) {
			return Component.translatable("agentcraft.hq.refused_hardcore");
		}
		if (!HqWorld.isHq(server) && !anyWorld()) {
			return Component.translatable("agentcraft.hq.refused_world", HqWorld.LEVEL_NAME, "-Dagentcraft.hq.anyworld=1");
		}
		return null;
	}

	public static boolean anyWorld() {
		String v = System.getProperty("agentcraft.hq.anyworld");
		if (v == null) {
			v = System.getenv("AGENTCRAFT_HQ_ANYWORLD");
		}
		return v != null && (v.trim().equals("1") || v.trim().equalsIgnoreCase("true") || v.trim().equalsIgnoreCase("on"));
	}

	private static int build(CommandContext<CommandSourceStack> ctx, String id, boolean force) {
		Component refused = refusal(ctx.getSource());
		if (refused != null) {
			ctx.getSource().sendFailure(refused);
			return 0;
		}
		HqBuilder builder = HqBuilders.get(id);
		if (builder == null) {
			ctx.getSource().sendFailure(Component.translatable("agentcraft.hq.unknown_builder", id, String.valueOf(HqBuilders.ids())));
			return 0;
		}
		Anchors.Layout layout;
		try {
			layout = buildAndPublish(ctx.getSource().getLevel(), builder, new HqBuilder.Options(force));
		} catch (RuntimeException e) {
			AgentCraft.LOGGER.error("HQ builder '{}' failed", id, e);
			ctx.getSource().sendFailure(Component.translatable("agentcraft.hq.builder_failed", id, String.valueOf(e)));
			return 0;
		}
		HqBuilder.Report report = lastBuild;
		ctx.getSource().sendSuccess(() -> {
			MutableComponent msg = Component.translatable("agentcraft.hq.built", id, layout.anchors().size());
			return report == null ? msg : msg.append(". ").append(report.message());
		}, true);
		return layout.anchors().size();
	}

	/** Runs {@code builder} (server thread), publishes its layout and moves the world spawn to its spawn anchor. */
	public static Anchors.Layout buildAndPublish(ServerLevel level, HqBuilder builder) {
		return buildAndPublish(level, builder, HqBuilder.Options.DEFAULT);
	}

	public static Anchors.Layout buildAndPublish(ServerLevel level, HqBuilder builder, HqBuilder.Options options) {
		long t0 = System.nanoTime();
		// another builder rewrites the same ground without a record: the studio's memory of its last
		// build no longer describes the world
		PlanStore.invalidateUnless(level.getServer(), builder.id());
		Anchors.Builder anchors = Anchors.builder(builder.id());
		HqBuilder.Report report = builder.build(level, anchors, options);
		lastBuild = report;
		lastReport = report == null ? null : report.log();
		Anchors.Layout layout = anchors.build();
		Anchors.publish(level.getServer(), layout);
		Anchor spawn = layout.get(AnchorNames.SPAWN);
		if (spawn != null) {
			level.getServer().getCommands().performPrefixedCommand(level.getServer().createCommandSourceStack().withSuppressedOutput(),
				String.format(Locale.ROOT, "setworldspawn %d %d %d %.1f 0", (int) Math.floor(spawn.x()), (int) Math.floor(spawn.y()),
					(int) Math.floor(spawn.z()), spawn.yaw()));
		}
		AgentCraft.LOGGER.info("HQ '{}' built in {} ms{}", builder.id(), (System.nanoTime() - t0) / 1_000_000,
			lastReport == null ? "" : ": " + lastReport);
		return layout;
	}
}
