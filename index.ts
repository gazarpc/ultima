import { Boom } from '@hapi/boom'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, downloadContentFromMessage, fetchLatestBaileysVersion, makeInMemoryStore, MessageRetryMap, useMultiFileAuthState } from './src'
import MAIN_LOGGER from './src/Utils/logger'
import { Sticker, createSticker, StickerTypes } from 'wa-sticker-formatter' // ES6

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = {}

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: state,
		msgRetryCounterMap,
		// implement to handle retries
		getMessage: async key => {
			return {
				conversation: 'hello'
			}
		}
	})

	store?.bind(sock.ev)

	sock.ev.on('messages.upsert', async m => { //CUANDO LLEGUE UN MENSAJE
		console.log(JSON.stringify(m, undefined, 2)) //MOSTRAR EN CONSOLA LOS MENSAJES

		const msg = m.messages[0] //GUARDAR EN LA VARIABLE MSG EL ULTIMO MENSAJE ENVIADO
		if (!msg.key.fromMe && m.type === 'notify' && doReplies) { //SI EL MENSAJE NO VIENE DE MI Y ES DEL TIPO NOTIFICACION
			console.log('replying to', m.messages[0].key.remoteJid) //RESPONDIENDO A → NUMERO DE TELF
			await sock!.sendReadReceipt(msg.key.remoteJid, msg.key.participant, [msg.key.id]) //LEER EL MENSAJE
			var jid = msg.key.remoteJid // ID DE LA PERSONA QUE ENVIÓ EL ULTIMO MENSAJE [numtelf@.....]
			var groupmemberjid = msg.key.participant // EN GRUPOS, PERSONA(ID) QUE ENVIO EL ULTIMO MENSAJE
			try {
				var MessageType = Object.keys(msg.message)[0] //TIPO DE MENSAJE ENVIADO (IMAGEN, VIDEO, AUDIO, ETC) SABER CUAL ES
			} catch (error) {
				console.log("Ocurrió un error: " + error)
			}
			if (MessageType === 'imageMessage') { //SI, EL TIPO DE MENSAJE ES UNA IMAGEN
				try {
					if (/@\bs\b/i.test(msg.message.imageMessage.caption)) { //SI EL MENSAJE INCLUIDO EN LA IMAGEN ES @S
						const stream = await downloadContentFromMessage(msg.message!.imageMessage!, 'image')
						let buffer = Buffer.from([])
						for await (const chunk of stream) {
							buffer = Buffer.concat([buffer, chunk])
						} 
						//todo lo anterior nos permite almacenar la imagen en BUFFER (TEMPORAL)
						const sticker = new Sticker(buffer, {
							pack: 'My Pack', // The pack name
							author: 'Me', // The author name
							type: StickerTypes.FULL, // The sticker type
							categories: ['🎉'], // The sticker category
							id: '12345', // The sticker id
							quality: 40, // The quality of the output file - mantenerlo en un peso no mayor a 1MB (40-50)
						})
						
						// or get Baileys-MD Compatible Object
						sock.sendMessage(jid, await sticker.toMessage())

					} else {
						
					}
				} catch (error) {
					console.log("ocurrió un error: "+ error)
				}
			} 
		}

	})

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update
		if (connection === 'close') {
			// reconnect if not logged out
			if ((lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
				startSock()
			} else {
				console.log('Connection closed. You are logged out.')
			}
		}

		console.log('connection update', update)
	})
	// listen for when the auth credentials is updated
	sock.ev.on('creds.update', saveCreds)

	return sock
}

startSock()