// Copyright (c)2022 Quinn Michaels
const fs = require('fs');
const path = require('path');
const net = require('net');
const {TelnetSocket} = require('telnet-stream');

const data_path = path.join(__dirname, 'data.json');
const {agent,vars} = require(data_path).data;

const Deva = require('@feecting/deva');
const TELNET = new Deva({
  agent: {
    uid: agent.uid,
    key: agent.key,
    name: agent.name,
    describe: agent.describe,
    prompt: agent.prompt,
    voice: agent.voice,
    profile: agent.profile,
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
    }
  },
  vars,
  deva: {},
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
      const parts = q.text.split(' ');
      const conn = parts[0].split(':');

      this.prompt(`OPEN:${q.meta.params[1]} ${q.text}`);
      console.log('CONN', conn);

      const connection = q.meta.params[1] ? q.meta.params[1] : this.vars.connection
      this.modules[connection] = {
        relayEvent: parts[1] || false,
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
            client: this.client,
            agent: this.agent,
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
        conn.write(this.agent.translate(text), () => {
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
      this.func.state('data', connection);
      text = this.agent.parse(text);
      if (text === this.vars.messages.clear) return this.talk(this.vars.clearevent);

      const {relayEvent, pending} = this.modules[connection]
      const {dataEvent} = this.vars;
      const theEvent = relayEvent || dataEvent;

      if (!relayEvent) this.prompt(text);
      this.talk(theEvent, {
        id: this.uid(),
        q: pending,
        a: {
          client:this.client,
          agent: this.agent,
          meta: {
            key: this.agent.key,
            method: 'data',
            connection,
          },
          text: text,
          html: text,
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
      this.func.state('error', connection);
      const {relayEvent, pending} = this.modules[connection]
      const {dataEvent} = this.vars;
      const theEvent = relayEvent || dataEvent;
      this.talk(theEvent, {
        id: this.uid(),
        q: pending,
        a: {
          client:this.client,
          agent: this.agent,
          meta: {
            key: this.agent.key,
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
        agent: this.agent,
        client: this.cleint,
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
      return this.func.open(packet);
    },

    /**************
    method: close
    params: packet
    describe: Close a specific telnet connection.
    ***************/
    close(packet) {
      const text = this.func.close(packet.q.text);
      return Promise.resolve({text});
    },

    /**************
    method: write
    params: packet
    describe: Method relay to the write function.
    ***************/
    write(packet) {
      return this.func.write(packet);
    },

    /**************
    method: >
    params: packet
    describe: Shortcut method to the write function.
    ***************/
    '>'(packet) {
      return this.func.write(packet);
    },

    /**************
    method: cmd
    params: packet
    describe: Method relay to the cmd function.
    ***************/
    cmd(packet) {
      return this.func.cmd(packet);
    },

    /**************
    method: uid
    params: packet
    describe: Return a unique id from the core module.
    ***************/
    uid(packet) {
      return Promise.resolve({text:this.uid()});
    },

    /**************
    method: status
    params: packet
    describe: Return the status for the Telnet Deva.
    ***************/
    status(packet) {
      return this.status();
    },

    /**************
    method: help
    params: packet
    describe: Return the help files for the Telnet Deva.
    ***************/
    help(packet) {
      return new Promise((resolve, reject) => {
        this.lib.help(packet.q.text, __dirname).then(help => {
          return this.question(`#feecting parse ${help}`);
        }).then(parsed => {
          return resolve({
            text: parsed.a.text,
            html: parsed.a.html,
            data: parsed.a.data,
          });
        }).catch(reject);
      });
    }
  },
});
module.exports = TELNET
