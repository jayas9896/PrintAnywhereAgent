# Operator Approval, Onboarding, and Recovery

This guide is for the print-shop owner or local PC operator using `PrintAnywhereAgent`.

## What changed in the operating model

The agent no longer assumes that the platform admin must create every printer manually.

The current model is:

1. you register the machine
2. you share the pairing code with the platform admin
3. the admin verifies your business manually
4. the admin sets the official business name and fallback GPS location
5. the admin approves the machine
6. after approval, you publish and manage your own customer-facing printers from the local Agent UI

## What you can manage locally

After approval, you can manage:

- which Windows printers are shared from this PC
- which customer-facing platform printers are published
- pricing
- printer status
- customer-visible capabilities
- secure cover packet settings
- document constraints
- usage-based pricing floor settings

## What you cannot manage locally

The following are controlled by the platform admin only:

- business name
- business address
- fallback shop latitude and longitude
- approval status

## First-time onboarding

1. Install the release bundle or run the source checkout bootstrap.
2. Start the agent.
3. Open the local UI at `http://127.0.0.1:43100` unless you changed the port.
4. Keep the prefilled production backend URL unless support tells you otherwise:
   `https://api.dhruvantasystems.net/printanywhere`.
5. Optionally set a machine display name.
6. Save the registration.
7. Share the pairing code with the platform admin.
8. Wait for the admin to verify the business and approve the machine.
9. Once the local UI shows the machine is approved, publish one or more platform printers.

The normal Windows install runs the agent hidden in the background, shows a Dhruvanta-branded tray icon, and creates Desktop/Start Menu shortcuts. Use the tray menu for refresh, restart, stop, and update actions. A visible terminal window means the diagnostic console runner was used; close it and start the agent from the shortcut or tray.

## Publishing your first platform printer

After approval:

1. Make sure the local Windows printer is marked as shared in the Agent UI.
2. In the `Published platform printers` section, publish a new printer.
3. Choose which shared local Windows printer backs that platform printer.
4. Set pricing and customer-facing capabilities.
5. Save the platform printer.

The platform printer reports the agent host location when the machine or browser can provide it. If no live device location is available, the backend uses the admin-approved business location automatically.

## Unpublishing a printer

Unpublishing is a soft disable.

That means:

- the printer stops appearing for new customer orders
- the record stays in the system for order history and audit review
- past print jobs still reference the same printer

This is expected behavior.

## Recovery flows

### I lost the pairing code

Ask the platform admin to generate a new pairing code from the admin portal.

### I installed or removed Windows printers

1. Open the Agent UI.
2. Click `Refresh printers now`.
3. Update sharing for the local printers you want to expose.
4. Adjust any published platform printers that should point at the changed local printers.

### The platform admin changed my business details

Refresh the Agent UI. The business name and location shown there should update automatically from the backend.

### My machine was suspended

When suspended:

- customer jobs stop routing through the machine
- local self-service printer management is blocked

Ask the platform admin why the machine was suspended. Only the admin can return it to approved state.

### I need to stop taking orders for one printer

Unpublish that platform printer from the local Agent UI. This is the normal soft-disable path.

### The machine was revoked

Revocation is stronger than suspension. If the UI shows the agent was revoked:

- stop using the machine for PrintAnywhere traffic
- contact the platform admin
- expect that you may need a fresh registration or reinstall depending on the reason

## Recommended daily operator checks

Before opening the shop:

1. Confirm the Agent UI loads.
2. Confirm the machine shows as approved.
3. Confirm the local Windows printers you need are still shared.
4. Confirm the published platform printers are enabled.
5. Confirm there is no last-error message in the health panel.

## Related docs

- [windows-setup.md](./windows-setup.md)
- [release-build.md](./release-build.md)
