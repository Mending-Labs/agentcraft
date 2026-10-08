package dev.agentcraft.net;

import io.netty.buffer.ByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;

/**
 * One agent as the host of a shared HQ simulates it this tick: everything its look depends on, so
 * every other player draws exactly the same agent (position, body and head, walk cycle, the posture
 * channels and the animation clock).
 *
 * @param pose     posture channels (arm/leg rotations, lean, weights, book; the client's AgentLife P_*)
 * @param age      the agent's animation clock (ticks): typing, talking and page flips follow it
 * @param posture  AgentLife.Posture ordinal
 * @param viewPose AgentPose ordinal (walk / sit / lean / stand)
 */
public record AgentFrame(String id, double x, double y, double z, float bodyYaw, float headYaw, float headPitch,
	float walkPosition, float walkSpeed, float[] pose, float sit, float drop, float typeW, float talkW, float exclaim,
	int age, int pageFlipStart, byte posture, byte viewPose) {
	/** Pose channels per agent (AgentLife.N). */
	public static final int CHANNELS = 16;

	public static final StreamCodec<ByteBuf, AgentFrame> CODEC = StreamCodec.of(AgentFrame::write, AgentFrame::read);

	private static void write(ByteBuf b, AgentFrame f) {
		ByteBufCodecs.stringUtf8(64).encode(b, f.id);
		b.writeDouble(f.x).writeDouble(f.y).writeDouble(f.z);
		b.writeFloat(f.bodyYaw).writeFloat(f.headYaw).writeFloat(f.headPitch);
		b.writeFloat(f.walkPosition).writeFloat(f.walkSpeed);
		for (int i = 0; i < CHANNELS; i++) {
			b.writeFloat(i < f.pose.length ? f.pose[i] : 0f);
		}
		b.writeFloat(f.sit).writeFloat(f.drop).writeFloat(f.typeW).writeFloat(f.talkW).writeFloat(f.exclaim);
		b.writeInt(f.age).writeInt(f.pageFlipStart);
		b.writeByte(f.posture).writeByte(f.viewPose);
	}

	private static AgentFrame read(ByteBuf b) {
		String id = ByteBufCodecs.stringUtf8(64).decode(b);
		double x = b.readDouble(), y = b.readDouble(), z = b.readDouble();
		float body = b.readFloat(), head = b.readFloat(), pitch = b.readFloat();
		float walkPos = b.readFloat(), walkSpeed = b.readFloat();
		float[] pose = new float[CHANNELS];
		for (int i = 0; i < CHANNELS; i++) {
			pose[i] = b.readFloat();
		}
		float sit = b.readFloat(), drop = b.readFloat(), typeW = b.readFloat(), talkW = b.readFloat(), exclaim = b.readFloat();
		int age = b.readInt(), flip = b.readInt();
		byte posture = b.readByte(), viewPose = b.readByte();
		return new AgentFrame(id, x, y, z, body, head, pitch, walkPos, walkSpeed, pose, sit, drop, typeW, talkW, exclaim, age, flip, posture, viewPose);
	}
}
