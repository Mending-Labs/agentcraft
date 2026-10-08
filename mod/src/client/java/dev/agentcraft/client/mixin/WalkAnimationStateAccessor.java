package dev.agentcraft.client.mixin;

import net.minecraft.world.entity.WalkAnimationState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** The walk cycle of an agent as its host computed it (shared HQ: every player sees the same step). */
@Mixin(WalkAnimationState.class)
public interface WalkAnimationStateAccessor {
	@Accessor("position")
	void agentcraft$setPosition(float position);

	@Accessor("speed")
	void agentcraft$setSpeed(float speed);

	@Accessor("speedOld")
	void agentcraft$setSpeedOld(float speedOld);

	@Accessor("speedOld")
	float agentcraft$speedOld();
}
