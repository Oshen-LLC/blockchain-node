const url = process.env.BRIDGE_HEALTHCHECK_URL || "http://127.0.0.1:4000/health";

const response = await fetch(url, {
  headers: { accept: "application/json" },
});

if (!response.ok) {
  console.error(`bridge healthcheck failed with ${response.status}`);
  process.exit(1);
}

const body = await response.json();
if (!body || typeof body.status !== "string") {
  console.error("bridge healthcheck returned an invalid payload");
  process.exit(1);
}

console.log(`bridge health: ${body.status}`);
