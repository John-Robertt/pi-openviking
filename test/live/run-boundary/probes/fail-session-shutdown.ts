export default function (pi) {
  pi.on("session_shutdown", async () => {
    throw new Error("gate injection: session_shutdown failure");
  });
}
