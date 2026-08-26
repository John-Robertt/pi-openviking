export default function (pi) {
  pi.on("session_start", async () => {
    throw new Error("gate injection: session_start failure");
  });
}
