const Datastore = require('nedb-promises');
const path = require('path');

const dbPath = path.join(__dirname, '../database');

const GroupStore = Datastore.create({ filename: path.join(dbPath, 'groups.db'), autoload: true });
const MessageStore = Datastore.create({ filename: path.join(dbPath, 'messages.db'), autoload: true });
const AliasStore = Datastore.create({ filename: path.join(dbPath, 'aliases.db'), autoload: true });

function createWrapper(store) {
    return {
        find: (...args) => store.find(...args),
        findOne: (...args) => store.findOne(...args),
        create: (doc) => store.insert(doc),
        updateOne: (filter, update) => {
            const modifier = {};
            const setProps = {};
            for (const key in update) {
                if (key.startsWith('$')) {
                    modifier[key] = update[key];
                } else {
                    setProps[key] = update[key];
                }
            }
            if (Object.keys(setProps).length > 0) {
                modifier.$set = { ...(modifier.$set || {}), ...setProps };
            }
            return store.update(filter, modifier, {});
        },
        findOneAndUpdate: async (filter, update, options) => {
            const modifier = {};
            const setProps = {};
            for (const key in update) {
                if (key.startsWith('$')) {
                    modifier[key] = update[key];
                } else {
                    setProps[key] = update[key];
                }
            }
            if (Object.keys(setProps).length > 0) {
                modifier.$set = { ...(modifier.$set || {}), ...setProps };
            }
            await store.update(filter, modifier, {});
            return await store.findOne(filter);
        }
    };
}

const Group = createWrapper(GroupStore);
const Message = createWrapper(MessageStore);
const Alias = createWrapper(AliasStore);

// Special case for Group model saving (since we do group.anonCounter += 1; group.save(); in whatsapp.js)
// We need to implement a hack or just update whatsapp.js to use updateOne instead.
// Let's modify whatsapp.js to not use group.save().

module.exports = { Group, Message, Alias };
