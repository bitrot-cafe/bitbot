import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canActOn, hasRole, parsePermissions, rankOf, rolesOf, setApplicationOwner, setRoles, unknownRoles } from './roles.js';

const OWNER = '100000000000000001';
const CHRIS = '100000000000000002';
const ADMIN = '100000000000000003';
const OPERATOR = '100000000000000004';
const NOBODY = '100000000000000005';
const user = (id: string) => ({ id });

test('permissions.yaml: valid file, and every kind of mistake is reported at once', () => {
  const roles = parsePermissions(`
roles:
  root:
    users: ["${CHRIS}"]
  admin: { staff: true, users: ["${ADMIN}"] }
  access-sync-operator: { users: ["${OPERATOR}"] }
  empty:
`);
  assert.deepEqual([...roles.keys()], ['root', 'admin', 'access-sync-operator', 'empty']);
  assert.equal(roles.get('admin')!.staff, true);
  assert.deepEqual([...roles.get('empty')!.users], []);
  assert.equal(parsePermissions('').size, 0); // an empty file: no roles

  const error = (() => {
    try {
      parsePermissions(`
admins: {}
roles:
  Root: {}
  admin: { users: [1234567890123456789, "nope"], staff: "yes", extra: 1 }
`);
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assert.match(error!, /unknown top-level key "admins"/);
  assert.match(error!, /role "Root": names are lower case/);
  assert.match(error!, /quote user IDs/);
  assert.match(error!, /"nope" isn't a user ID/);
  assert.match(error!, /staff must be true or false/);
  assert.match(error!, /unknown key "extra"/);
  assert.throws(() => parsePermissions('roles: [a, b]'), /must be a mapping/);
  assert.throws(() => parsePermissions('roles: {'), /isn't valid YAML/);
});

test('roles: owner and listed users are root; root holds every role; rank and immunity', async () => {
  setRoles(`
roles:
  root: { users: ["${CHRIS}"] }
  admin: { users: ["${ADMIN}"] }
  access-sync-operator: { users: ["${OPERATOR}"] }
  typo-role: {}
`);
  setApplicationOwner(OWNER);
  for (const id of [OWNER, CHRIS]) {
    assert.ok(await hasRole(user(id), 'root'));
    assert.ok(await hasRole(user(id), 'admin'));
    assert.ok(await hasRole(user(id), 'access-sync-operator'));
    assert.ok(await hasRole(user(id), 'role-only-a-plugin-knows'));
    assert.equal(await rankOf(user(id)), 2);
  }
  assert.deepEqual([...(await rolesOf(user(ADMIN)))], ['admin']);
  assert.ok(!(await hasRole(user(ADMIN), 'root')));
  assert.ok(!(await hasRole(user(ADMIN), 'access-sync-operator')));
  assert.equal(await rankOf(user(ADMIN)), 1);
  assert.ok(await hasRole(user(OPERATOR), 'access-sync-operator'));
  assert.equal(await rankOf(user(OPERATOR)), 0); // custom roles carry no rank
  assert.equal(await rankOf(user(NOBODY)), 0);

  // Immunity: admins can't act on root; root can act on anyone; equals can act on each other.
  assert.ok(!(await canActOn(user(ADMIN), user(CHRIS))));
  assert.ok(await canActOn(user(CHRIS), user(ADMIN)));
  assert.ok(await canActOn(user(CHRIS), user(OWNER)));
  assert.ok(await canActOn(user(ADMIN), user(NOBODY)));
  assert.ok(!(await canActOn(user(NOBODY), user(ADMIN))));

  assert.deepEqual(unknownRoles(['access-sync-operator']), ['typo-role']);
  setApplicationOwner(null);
  setRoles('');
});

test('immunity with an ID-only target: staff-granted admins are looked up, and unknown fails closed', async () => {
  const { setRolesClient } = await import('./roles.js');
  const STAFF = '100000000000000009';
  setRoles(`
roles:
  admin: { staff: true }
`);
  setApplicationOwner(null);
  const actor = { id: NOBODY, flags: 0 };

  // No client to look the target up with: unknown, so canActOn refuses, and nothing is cached wrongly.
  setRolesClient(null);
  assert.equal(await canActOn(actor, { id: STAFF }), false);

  // With a client, the staff flag is fetched: the target is an admin, so a nobody can't act on them.
  const Staff = (await import('@fluxerjs/core')).UserFlagsBits.Staff;
  setRolesClient({ users: { fetch: async (id: string) => ({ id, flags: id === STAFF ? Number(Staff) : 0 }) } } as never);
  assert.equal(await rankOf({ id: STAFF }), 1);
  assert.equal(await canActOn(actor, { id: STAFF }), false);
  assert.equal(await canActOn({ id: STAFF }, actor), true);
  assert.ok(await hasRole({ id: STAFF }, 'admin')); // the earlier unknown answer wasn't cached

  setRolesClient(null);
  setRoles('');
});

test("immunity: root may act on a target that can't be looked up; one lookup per user", async () => {
  const { setRolesClient } = await import('./roles.js');
  setRoles(`
roles:
  admin: { staff: true }
`);
  setApplicationOwner(OWNER);
  let fetches = 0;
  setRolesClient({
    users: {
      fetch: async (id: string) => {
        fetches++;
        if (id === 'deleted') throw new Error('Unknown user');
        return { id, flags: 0 };
      },
    },
  } as never);
  assert.equal(await canActOn({ id: OWNER, flags: 0 }, { id: 'deleted' }), true); // root outranks everyone
  assert.equal(await canActOn({ id: NOBODY, flags: 0 }, { id: 'deleted' }), false); // unknown: fail closed
  fetches = 0;
  assert.equal(await canActOn({ id: NOBODY, flags: 0 }, { id: '100000000000000077' }), true);
  assert.equal(fetches, 1);
  setRolesClient(null);
  setApplicationOwner(null);
  setRoles('');
});
