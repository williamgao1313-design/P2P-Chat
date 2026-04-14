import React, { useState, useEffect, useRef } from 'react';
import mqtt from 'mqtt';
import { v4 as uuidv4 } from 'uuid';
import { Phone, Video, Image as ImageIcon, Mic, Send, X, PhoneOff, Check, MessageSquare, LogOut, ChevronLeft } from 'lucide-react';
import localforage from 'localforage';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type MessageType = 'text' | 'image' | 'voice';

interface Message {
  id: string;
  senderId: string;
  type: MessageType;
  content: string;
  timestamp: number;
}

const MQTT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_PREFIX = 'ais-p2p-chat-v1/user/';

export default function App() {
  const [myId, setMyId] = useState<string>(localStorage.getItem('myId') || '');
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(!!localStorage.getItem('myId'));
  
  const [recentPeers, setRecentPeers] = useState<string[]>([]);
  const [activePeerId, setActivePeerId] = useState<string>('');
  const [peerIdInput, setPeerIdInput] = useState<string>('');
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);

  // Call state
  const [callState, setCallState] = useState<'idle' | 'calling' | 'receiving' | 'connected'>('idle');
  const [incomingCall, setIncomingCall] = useState<{ from: string; offer: any; isVideo: boolean } | null>(null);
  const [isVideoCall, setIsVideoCall] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use refs for callbacks to access latest state
  const activePeerIdRef = useRef(activePeerId);
  const myIdRef = useRef(myId);
  const mqttClientRef = useRef<mqtt.MqttClient | null>(null);

  useEffect(() => {
    activePeerIdRef.current = activePeerId;
  }, [activePeerId]);

  useEffect(() => {
    myIdRef.current = myId;
  }, [myId]);

  // Load recent peers on login
  useEffect(() => {
    if (isLoggedIn && myId) {
      localforage.getItem<string[]>(`peers_${myId}`).then((peers) => {
        if (peers) setRecentPeers(peers);
      });
    }
  }, [isLoggedIn, myId]);

  // Load chat history when active peer changes
  useEffect(() => {
    if (isLoggedIn && myId && activePeerId) {
      localforage.getItem<Message[]>(`chat_${myId}_${activePeerId}`).then((history) => {
        setMessages(history || []);
      });
    }
  }, [activePeerId, isLoggedIn, myId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // MQTT Connection and Message Handling
  useEffect(() => {
    if (!isLoggedIn || !myId) return;

    const client = mqtt.connect(MQTT_BROKER);
    mqttClientRef.current = client;

    client.on('connect', () => {
      console.log('Connected to MQTT Broker');
      client.subscribe(`${TOPIC_PREFIX}${myId}`);
    });

    client.on('message', async (topic, msgBuffer) => {
      try {
        const data = JSON.parse(msgBuffer.toString());
        const { type, from } = data;
        const currentMyId = myIdRef.current;
        const currentActivePeer = activePeerIdRef.current;

        if (type === 'message') {
          // Save to local storage
          const key = `chat_${currentMyId}_${from}`;
          const history = await localforage.getItem<Message[]>(key) || [];
          history.push(data.message);
          await localforage.setItem(key, history);

          // Update recent peers
          const peersKey = `peers_${currentMyId}`;
          const peers = await localforage.getItem<string[]>(peersKey) || [];
          const newPeers = [from, ...peers.filter(p => p !== from)];
          await localforage.setItem(peersKey, newPeers);
          setRecentPeers(newPeers);

          if (from === currentActivePeer) {
            setMessages((prev) => [...prev, data.message]);
          }
        } else if (type === 'call-request') {
          setIncomingCall({ from, offer: data.offer, isVideo: data.isVideo });
          setCallState('receiving');
        } else if (type === 'call-answer') {
          if (peerConnection.current) {
            await peerConnection.current.setRemoteDescription(new RTCSessionDescription(data.answer));
            setCallState('connected');
          }
        } else if (type === 'ice-candidate') {
          if (peerConnection.current) {
            try {
              await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
              console.error('Error adding received ice candidate', e);
            }
          }
        } else if (type === 'call-end') {
          endCall(false);
        } else if (type === 'call-reject') {
          endCall(false);
          alert('Call was rejected.');
        }
      } catch (e) {
        console.error('Failed to process message', e);
      }
    });

    return () => {
      client.end();
      mqttClientRef.current = null;
    };
  }, [isLoggedIn, myId]);

  const sendSignal = (to: string, type: string, payload: any = {}) => {
    if (!mqttClientRef.current || !myIdRef.current || !to) return;
    const topic = `${TOPIC_PREFIX}${to}`;
    const message = JSON.stringify({ type, from: myIdRef.current, ...payload });
    mqttClientRef.current.publish(topic, message);
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (myId.trim()) {
      localStorage.setItem('myId', myId.trim());
      setIsLoggedIn(true);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('myId');
    setIsLoggedIn(false);
    setMyId('');
    setActivePeerId('');
    setMessages([]);
  };

  const setupPeerConnection = () => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.qq.com:3478' },
        { urls: 'stun:stun.miwifi.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' }
      ],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const target = activePeerIdRef.current || incomingCall?.from;
        if (target) {
          sendSignal(target, 'ice-candidate', { candidate: event.candidate });
        }
      }
    };

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    if (localStream.current) {
      localStream.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStream.current!);
      });
    }

    peerConnection.current = pc;
    return pc;
  };

  const startCall = async (video: boolean) => {
    if (!activePeerId) return;
    setIsVideoCall(video);
    setCallState('calling');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const pc = setupPeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal(activePeerId, 'call-request', { offer, isVideo: video });
    } catch (err) {
      console.error('Error accessing media devices.', err);
      setCallState('idle');
      alert('Could not access camera/microphone.');
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    setIsVideoCall(incomingCall.isVideo);
    setActivePeerId(incomingCall.from);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: incomingCall.isVideo, audio: true });
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const pc = setupPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendSignal(incomingCall.from, 'call-answer', { answer });

      setCallState('connected');
      setIncomingCall(null);
    } catch (err) {
      console.error('Error accessing media devices.', err);
      rejectCall();
    }
  };

  const rejectCall = () => {
    if (incomingCall) {
      sendSignal(incomingCall.from, 'call-reject');
      setIncomingCall(null);
      setCallState('idle');
    }
  };

  const endCall = (emit = true) => {
    const target = activePeerId || incomingCall?.from;
    if (emit && target) {
      sendSignal(target, 'call-end');
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    if (localStream.current) {
      localStream.current.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    
    setCallState('idle');
    setIncomingCall(null);
  };

  const saveAndSendMessage = async (type: MessageType, content: string) => {
    if (!activePeerId) return;
    const msg: Message = {
      id: uuidv4(),
      senderId: myId,
      type,
      content,
      timestamp: Date.now(),
    };
    
    // Update UI
    setMessages((prev) => [...prev, msg]);
    
    // Save to local storage
    const key = `chat_${myId}_${activePeerId}`;
    const history = await localforage.getItem<Message[]>(key) || [];
    history.push(msg);
    await localforage.setItem(key, history);

    // Update recent peers
    const peersKey = `peers_${myId}`;
    const peers = await localforage.getItem<string[]>(peersKey) || [];
    const newPeers = [activePeerId, ...peers.filter(p => p !== activePeerId)];
    await localforage.setItem(peersKey, newPeers);
    setRecentPeers(newPeers);

    // Send via MQTT
    sendSignal(activePeerId, 'message', { message: msg });
  };

  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    saveAndSendMessage('text', inputText);
    setInputText('');
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          saveAndSendMessage('image', reader.result);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorder.current = recorder;
      audioChunks.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            saveAndSendMessage('voice', reader.result);
          }
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Error accessing microphone', err);
      alert('Could not access microphone.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && isRecording) {
      mediaRecorder.current.stop();
      setIsRecording(false);
    }
  };

  const handleConnectPeer = (e: React.FormEvent) => {
    e.preventDefault();
    if (peerIdInput.trim()) {
      setActivePeerId(peerIdInput.trim());
      setPeerIdInput('');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-blue-600" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-gray-900 mb-2">Welcome to P2P Chat</h1>
          <p className="text-center text-gray-500 mb-8">Enter a fixed ID to login and keep your chat history.</p>
          
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Your ID</label>
              <input
                type="text"
                required
                placeholder="e.g., alice123"
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                value={myId}
                onChange={(e) => setMyId(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 transition-colors"
            >
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] bg-white font-sans overflow-hidden">
      {/* Sidebar (Hidden on mobile when chat is active) */}
      <div className={cn(
        "w-full md:w-80 bg-gray-50 border-r border-gray-200 flex flex-col flex-shrink-0 transition-transform duration-300",
        activePeerId ? "hidden md:flex" : "flex"
      )}>
        <div className="p-4 border-b border-gray-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold">
              {myId.charAt(0).toUpperCase()}
            </div>
            <span className="font-semibold text-gray-900 truncate max-w-[120px]">{myId}</span>
          </div>
          <button onClick={handleLogout} className="p-2 text-gray-500 hover:bg-gray-100 rounded-full" title="Logout">
            <LogOut size={18} />
          </button>
        </div>
        
        <div className="p-4">
          <form onSubmit={handleConnectPeer} className="flex gap-2">
            <input
              type="text"
              placeholder="Enter Peer ID..."
              className="flex-1 px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              value={peerIdInput}
              onChange={(e) => setPeerIdInput(e.target.value)}
            />
            <button type="submit" className="bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
              Chat
            </button>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Recent Chats
          </div>
          {recentPeers.length === 0 ? (
            <div className="p-4 text-sm text-gray-400 text-center">No recent chats</div>
          ) : (
            <ul className="space-y-1 px-2">
              {recentPeers.map(peer => (
                <li key={peer}>
                  <button
                    onClick={() => setActivePeerId(peer)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors text-left",
                      activePeerId === peer ? "bg-blue-100 text-blue-900" : "hover:bg-gray-100 text-gray-700"
                    )}
                  >
                    <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 font-medium text-gray-600">
                      {peer.charAt(0).toUpperCase()}
                    </div>
                    <span className="font-medium truncate">{peer}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className={cn(
        "flex-1 flex flex-col bg-white min-w-0",
        !activePeerId ? "hidden md:flex" : "flex"
      )}>
        {!activePeerId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 bg-gray-50/50">
            <MessageSquare className="w-16 h-16 mb-4 text-gray-300" />
            <p className="text-lg font-medium text-gray-500">Select a chat or start a new one</p>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <header className="h-16 border-b border-gray-200 flex items-center justify-between px-4 bg-white flex-shrink-0">
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => setActivePeerId('')}
                  className="md:hidden p-2 -ml-2 text-gray-500 hover:bg-gray-100 rounded-full"
                >
                  <ChevronLeft size={24} />
                </button>
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
                  {activePeerId.charAt(0).toUpperCase()}
                </div>
                <span className="font-semibold text-gray-900">{activePeerId}</span>
              </div>
              
              <div className="flex items-center gap-1">
                <button
                  onClick={() => startCall(false)}
                  disabled={callState !== 'idle'}
                  className="p-2.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-50"
                >
                  <Phone size={20} />
                </button>
                <button
                  onClick={() => startCall(true)}
                  disabled={callState !== 'idle'}
                  className="p-2.5 text-gray-600 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-50"
                >
                  <Video size={20} />
                </button>
              </div>
            </header>

            {/* Messages */}
            <main className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 bg-[#f8f9fa]">
              {messages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                  This is the beginning of your chat with {activePeerId}
                </div>
              ) : (
                messages.map((msg) => {
                  const isMe = msg.senderId === myId;
                  return (
                    <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={cn(
                          "max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-2 shadow-sm",
                          isMe ? "bg-blue-600 text-white rounded-br-sm" : "bg-white border border-gray-100 text-gray-800 rounded-bl-sm"
                        )}
                      >
                        {msg.type === 'text' && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{msg.content}</p>}
                        {msg.type === 'image' && (
                          <img src={msg.content} alt="Shared image" className="max-w-full rounded-lg mt-1" />
                        )}
                        {msg.type === 'voice' && (
                          <audio controls src={msg.content} className="max-w-full h-10 mt-1" />
                        )}
                        <div className={cn(
                          "text-[10px] mt-1 text-right",
                          isMe ? "text-blue-200" : "text-gray-400"
                        )}>
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </main>

            {/* Input Area */}
            <footer className="bg-white border-t border-gray-200 p-3 pb-safe">
              <form onSubmit={handleSendText} className="flex items-end gap-2 max-w-4xl mx-auto">
                <label className="p-2.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-full cursor-pointer transition-colors flex-shrink-0">
                  <ImageIcon size={22} />
                  <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </label>
                
                <div className="flex-1 bg-gray-100 rounded-2xl flex items-center px-4 py-2 min-h-[44px]">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Message..."
                    className="flex-1 bg-transparent border-none focus:outline-none py-1 text-[15px]"
                  />
                </div>

                {inputText.trim() ? (
                  <button
                    type="submit"
                    className="p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors flex-shrink-0 shadow-sm"
                  >
                    <Send size={20} className="ml-0.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onMouseLeave={stopRecording}
                    onTouchStart={startRecording}
                    onTouchEnd={stopRecording}
                    className={cn(
                      "p-3 rounded-full transition-colors flex-shrink-0 shadow-sm",
                      isRecording ? "bg-red-500 text-white animate-pulse" : "bg-blue-600 text-white hover:bg-blue-700"
                    )}
                  >
                    <Mic size={20} />
                  </button>
                )}
              </form>
            </footer>
          </>
        )}
      </div>

      {/* Call Overlays */}
      {callState !== 'idle' && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center backdrop-blur-sm">
          {callState === 'receiving' && incomingCall ? (
            <div className="bg-gray-900 rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl border border-gray-800 m-4">
              <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6">
                {incomingCall.isVideo ? <Video size={40} className="text-white" /> : <Phone size={40} className="text-white" />}
              </div>
              <h2 className="text-2xl font-bold text-white mb-2">{incomingCall.from}</h2>
              <p className="text-gray-400 mb-8">Incoming {incomingCall.isVideo ? 'video' : 'voice'} call...</p>
              <div className="flex justify-center gap-8">
                <button
                  onClick={rejectCall}
                  className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center text-white hover:bg-red-600 transition-transform hover:scale-105 shadow-lg"
                >
                  <PhoneOff size={28} />
                </button>
                <button
                  onClick={acceptCall}
                  className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center text-white hover:bg-green-600 transition-transform hover:scale-105 shadow-lg animate-bounce"
                >
                  <Check size={32} />
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full h-full flex flex-col relative">
              {/* Remote Video (Full Screen) */}
              <div className="flex-1 bg-black relative">
                {isVideoCall ? (
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center flex-col gap-6">
                    <div className="w-32 h-32 bg-gray-800 rounded-full flex items-center justify-center shadow-2xl">
                      <div className="text-4xl font-bold text-white">
                        {(activePeerId || incomingCall?.from || '?').charAt(0).toUpperCase()}
                      </div>
                    </div>
                    <div className="text-white text-2xl font-medium">
                      {callState === 'calling' ? 'Calling...' : 'Connected'}
                    </div>
                  </div>
                )}
              </div>

              {/* Local Video (Picture in Picture) */}
              {isVideoCall && (
                <div className="absolute top-safe right-4 mt-4 w-28 h-40 md:w-40 md:h-56 bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border-2 border-gray-700 z-10">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                </div>
              )}

              {/* Call Controls */}
              <div className="absolute bottom-safe left-0 right-0 mb-8 flex justify-center z-10">
                <div className="bg-gray-900/80 backdrop-blur-xl px-8 py-4 rounded-full flex items-center gap-8 shadow-2xl border border-gray-800">
                  <button
                    onClick={() => endCall(true)}
                    className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center text-white hover:bg-red-600 transition-transform hover:scale-105 shadow-lg"
                  >
                    <PhoneOff size={28} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
