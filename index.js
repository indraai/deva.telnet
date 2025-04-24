// Copyright (c)2022 Quinn Michaels
//  Telnet Deva

import Deva from '@indra.ai/deva';
import pkg from './package.json' with {type:'json'};
const {agent,vars} = pkg.data;

// set the __dirname
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';    
const __dirname = dirname(fileURLToPath(import.meta.url));

import net from 'node:net';
import {TelnetSocket} from 'telnet-stream';

const info = {
  id: pkg.id,
  name: pkg.name,
  describe: pkg.description,
  version: pkg.version,
  dir: __dirname,
  url: pkg.homepage,
  git: pkg.repository.url,
  bugs: pkg.bugs.url,
  author: pkg.author,
  license: pkg.license,
  copyright: pkg.copyright,
};

const TELNET = new Deva({
  info,
  agent,
  vars,
  utils: {
    translate(input) {
      return input.trim() + '\n\r';
    },

    /**************
    func: parse
    params: input
    describe: The Agent parse function cleans up the text that is returned
    from the telnet server for proper display in the terminal.
    ***************/
    parse(input) {
      const ansipattern = [
      		'[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
      		'(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
      	].join('|');

      const ansireg = new RegExp(ansipattern, 'g');

      // html ansi colors
      const text = input.toString('utf8')
        .replace(/(<)(.+?)(>)/g, '[$2]') // replace angle brackets with square.
        .replace(ansireg, ''); // remove ansi colors.

      return text;
    },
    process(input) {
      return input.trim();
    }
  },
  listeners: {},
  modules: {},
  func: {
    /**************
    func: state
    params: st, connection
    describe: Sets the state of the specific connection.
    ***************/
    state(st, connection) {
      const conn = this.modules[connection];
      if (st === 'done') conn.pending = false;
      conn.state = this.vars.states[st];
      // this.prompt(this.vars.state);
    },

    /**************
    func: open
    params: packet
    describe: Open a new Telnet connection with the packet parameters.
    ***************/
    open(packet) {
      const {id, q, created} = packet;
      // so here we need a name which is going to be param 1
      const conn = q.text.split(':');

      const relayEvent = q.data.relay || false;
      console.log('OPEN PACKET', relayEvent);
      this.prompt(`${relayEvent}:${q.meta.params[1]} ${q.text}`);
      const connection = q.meta.params[1] ? q.meta.params[1] : this.vars.connection
      this.modules[connection] = {
        relayEvent,
        host: conn[0] || false,
        port: conn[1] || false,
        timeout: conn[2] || this.vars.timeout,
        pending: packet.q,
        state: false,
        telnet: false,
        created: Date.now,
      };

      // we are going to put in sessions to open to different hosts and put them into different sockets
      return new Promise((resolve, reject) => {
        try {
          this.func.state('connecting', connection);
          const socket = net.createConnection(this.modules[connection].port, this.modules[connection].host).setKeepAlive(true);
          socket.setTimeout(this.vars.timeout, () => {
            this.prompt(`TIMEOUT: ${this.modules[connection].host}:${this.modules[connection].port}`);
            this.modules[connection].telnet.destroy();
            delete this.modules[connection];
          });
          socket.on('error', err => {
            this.func.onError(err, connection);
          });

          this.modules[connection].telnet = new TelnetSocket(socket);
          this.modules[connection].telnet.on('data', data => {
            return this.func.onData(data, connection);
          }).on('command', data => {
            return this.func.onCommand(data, connection);
          }).on('will', data => {
            return this.func.onWill(data, connection);
          }).on('wont', data => {
            return this.func.onWont(data, connection);
          }).on('do', data => {
            return this.func.onDo(data, connection);
          }).on('dont', data => {
            return this.func.onDont(data, connection);
          }).on('sub', data => {
            return this.func.onSub(data, connection);
          }).on('end', data => {
            return this.func.onEnd(data, connection);
          }).on('close', data => {
            return this.func.onClose(data, connection);
          }).on('destroy', data => {
            return this.func.onDestroy(data, connection);
          });
          this.func.state('connected', connection);
          return resolve(`${this.vars.messages.connect} ${connection}`);
        } catch (e) {
          console.error(e);
          this.func.state('error', connection);
          this.talk('error', {
            id: this.uid(),
            client: this.client(),
            agent: this.agent(),
            error: e.toString(),
            created: Date.now(),
          });
          return reject(e);
        }
      });
    },

    /**************
    func: close
    params: connection
    describe: Close a specific telnet connection.
    ***************/
    close(connection = false) {
      connection = connection ? connection : this.vars.connection;
      this.func.state('close', connection);
      this.modules[connection].telnet.destroy();
      delete this.modules[connection];
      return `${this.vars.messages.close} - ${connection}`;
    },

    /**************
    func: write
    params: packet
    describe: Write to a specific telnet connection with the provided packet
    data.
    ***************/
    write(packet) {
      const {text,meta} = packet.q;
      if (meta.params[1]) this.vars.connection = meta.params[1];

      const conn = this.modules[this.vars.connection].telnet

      return new Promise((resolve, reject) => {
        if (!this.modules[this.vars.connection]) return resolve(this.vars.messages.noconnect);

        this.func.state('write', this.vars.connection);
        conn.write(this.utils.translate(text), () => {
          this.modules[this.vars.connection].pending = packet.q;
          this.func.state('pending', this.vars.connection);
          return resolve();
        });
      });
    },

    /**************
    func: cmd
    params: packet
    describe: Send a command to the specificed telnet connection
    ***************/
    cmd(packet) {
      const connection = packet.q.meta.params[1] ? packet.q.meta.params[1] : this.vars.connection;
      return Promise.resolve(this.modules[connection].telnet.writeCommand(text));
    },

    /**************
    func: onData
    params: packet
    describe: The onData function is the handler that deals with data that is
    recieved from the telnet connection.
    ***************/
    onData(text, connection) {
      if (!text.length) return;
      const agent = this.agent();
      const client = this.client();
      this.func.state('data', connection);
      text = this.utils.parse(text);
      if (text === this.vars.messages.clear) return this.talk(this.vars.clearevent);

      const {relayEvent, pending} = this.modules[connection]
      const {dataEvent} = this.vars;
      const theEvent = relayEvent || dataEvent;

      if (!relayEvent) this.prompt(text);
      this.talk(theEvent, {
        id: this.uid(),
        q: pending,
        a: {
          client,
          agent,
          meta: {
            key: agent.key,
            method: 'data',
            connection,
          },
          text: text,
          html: false,
          created: Date.now(),
        },
        created: Date.now(),
      });
      this.func.state('done', connection);
    },
    onCommand(data, connection) {},
    onWill(data, connection) {},
    onWont(data, connection) {},
    onDo(data, connection) {},
    onDont(data, connection) {},
    onSub(data, connection) {},

    /**************
    func: onError
    params: err, connection
    describe: The specific onError handler for the Telnet connection and NOT
    for the overall DEVA. This is for specific connections only.
    ***************/
    onError(err, connection) {
      const agent = this.agent();
      const client = this.client();
      this.func.state('error', connection);
      const {relayEvent, pending} = this.modules[connection]
      const {dataEvent} = this.vars;
      const theEvent = relayEvent || dataEvent;
      this.talk(theEvent, {
        id: this.uid(),
        q: pending,
        a: {
          client,
          agent,
          meta: {
            key: agent.key,
            method: 'error',
          },
          text: err.toString('utf8'),
          error: err.toString('utf8'),
          created: Date.now(),
        },
        created: Date.now(),
      });
      this.vars.pending = false;

      this.talk('error', {
        id: this.uid(),
        agent,
        client,
        error: err.toString(),
        created: Date.now()
      })
    },

    /**************
    func: onClose
    params: data, connection
    describe: The onClose event handler for when a telnet connection is closed.
    ***************/
    onClose(data, connection) {
      this.prompt(this.vars.messages.close);
    },

    /**************
    func: onEnd
    params: data, connection
    describe: The onEnd handler is triggered when a telnet connection ends.
    ***************/
    onEnd(data, connection) {
      this.prompt(this.vars.messages.end);
    },

    /**************
    func: onDestroy
    params: data, connection
    describe: The onDestroy handler is triggered when a connection is destroyed.
    ***************/
    onDestroy(data, connection) {
      this.prompt(this.vars.messages.destroy);
    },
  },
  methods: {
    /**************
    method: open
    params: packet
    describe: Method relay to the open function.
    ***************/
    open(packet) {
      this.context('open');
      return this.func.open(packet);
    },

    /**************
    method: close
    params: packet
    describe: Close a specific telnet connection.
    ***************/
    close(packet) {
      this.context('close');
      const text = this.func.close(packet.q.text);
      return Promise.resolve({text});
    },

    /**************
    method: write
    params: packet
    describe: Method relay to the write function.
    ***************/
    write(packet) {
      this.context('write');
      return this.func.write(packet);
    },

    /**************
    method: >
    params: packet
    describe: Shortcut method to the write function.
    ***************/
    '>'(packet) {
      this.context('write');
      return this.func.write(packet);
    },

    /**************
    method: cmd
    params: packet
    describe: Method relay to the cmd function.
    ***************/
    cmd(packet) {
      this.context('cmd');
      return this.func.cmd(packet);
    },

    /**************
    method: issue
    params: packet
    describe: create a new issue for the main deva.world through github agent.
    ***************/
    issue(packet) {
      const agent = this.agent();
      return new Promise((resolve, reject) => {
        this.question(`#github issue:${agent.key} ${packet.q.text}`).then(issue => {
          return resolve({
            text: issue.a.text,
            html: issue.a.html,
            data: issue.a.data,
          })
        }).catch(err => {
          return this.error(err, packet, reject);
        });
      });
    },
  },
  onReady(data, resolve) {
    this.prompt(this.vars.messages.ready);
    return resolve(data);
  },
  onError(err, data, reject) {
    this.prompt(this.vars.messages.error);
    console.log(err);
    return reject(err);
  },
});
export default TELNET
