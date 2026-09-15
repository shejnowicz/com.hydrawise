# Rain sensor integration

Adds a separate `rain_sensor` driver to Hunter Hydrawise 1.6.0. Existing zone
identities, REST credentials, zone commands and polling remain unchanged.

## Meaning and source

The device reads GraphQL `me.controllers.sensors.status.active`. It does not
infer rain from suspended watering, a zone's schedule, or sensor model settings.
Homey's read-only `alarm_generic` is titled “Rain sensor active”. `true` means
the Hydrawise sensor is active, not a measured precipitation rate. Rain sensors
can remain active after rainfall until they dry.

Only models containing `rain sensor` are initially offered, matching Home
Assistant's established discovery predicate. Custom/other model names require
verification with real account data before widening discovery. Unknown/null
state, removed sensors, offline controllers and request errors mark the device
unavailable; they never write a false dry reading.

Protocol references inspected 2026-09-15:
- https://github.com/dknowles2/pydrawise/blob/main/pydrawise/hydrawise.graphql
- https://github.com/dknowles2/pydrawise/blob/main/pydrawise/auth.py
- https://github.com/home-assistant/core/blob/dev/homeassistant/components/hydrawise/binary_sensor.py

GraphQL is not the published REST v1 API. Endpoint/schema/auth compatibility
must be verified against the owner's real account before declaring success.
The fixed OAuth client identifier and client secret are public application
identifiers used by pydrawise, not the owner's account credentials.

## Pair and repair

Add device → Hunter Hydrawise → Rain sensor → sign in with the Hydrawise
account → choose the discovered sensor. The REST API key is not sufficient
for this GraphQL authentication. Use device Repair to re-authenticate.

Passwords are used only for authentication and are never persisted or logged.
Access/refresh tokens and account ID are stored in app setting `rainSensorAuth`,
not device data or pairing results. Rotated refresh tokens are persisted so
restart can continue without saving a password. One Hydrawise account per
rain-sensor driver; repair rejects a different account while sensors are paired.
Existing REST `api_key` is untouched. Do not publish an app-settings dump.

Polling starts immediately after initialization and then runs every 60 seconds,
independent of optional zone polling. A shared pending request and 30-second
cache coalesce requests from multiple rain devices. HTTP 429 establishes a
shared backoff of at least 60 seconds, honoring numeric/date Retry-After.
Requests time out after 30 seconds. Late responses after device deletion or
client replacement do not overwrite state. Main-stream watering operations
are not invoked by this driver.

## Verification

`npm test` tests state interpretation, error behavior, request coalescing,
authentication refresh, backoff and device lifecycle using mocked network/SDK.
`homey app validate --level publish` checks Homey manifests; it does not prove
cloud authentication or actual sensor discovery.

Remaining live acceptance:
1. Authenticate the owner's account and verify returned sensor model, ID and
   `status.active` against the Hydrawise Sensors screen.
2. Install reviewed build, pair the sensor, confirm the same boolean in Homey.
3. Verify an active/inactive change when a real sensor test is feasible; no
   remote irrigation or sensor-bypass commands are needed for this feature.
4. Restart app; verify refresh-backed read and device availability.
5. Verify existing zones and settings survive the update unchanged.

No live account verification or hub installation has been performed yet.
