class FamilyLocator {
    constructor() {
        // Config Supabase (substitua pelos seus dados)
        const supabaseUrl = 'https://SEU-PROJETO.supabase.co';
        const supabaseKey = 'sua-anon-key-aqui';
        this.supabase = supabase.createClient(supabaseUrl, supabaseKey);
        
        this.map = null;
        this.userMarker = null;
        this.familyMarkers = new Map();
        this.watchId = null;
        this.isSharing = false;
        this.userId = crypto.randomUUID();
        this.userName = prompt('👤 Seu nome na família:') || 'Membro';
        this.roomId = new URLSearchParams(window.location.search).get('room') || 
                     crypto.randomUUID().slice(0, 8);
        
        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadMap();
        await this.createRoom();
        this.listenToFamily();
        this.updateStatus('🟢 Conectado!', 'Conectado ao Supabase', '#4ecdc4');
        this.generateQR();
    }

    bindEvents() {
        document.getElementById('shareBtn').onclick = () => this.startSharing();
        document.getElementById('stopBtn').onclick = () => this.stopSharing();
        document.getElementById('copyBtn').onclick = () => this.copyLink();
    }

    async loadMap() {
        this.map = L.map('map').setView([-23.5505, -46.6333], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap | Family Locator'
        }).addTo(this.map);
    }

    async createRoom() {
        const { data, error } = await this.supabase
            .from('family_rooms')
            .upsert({ room_id: this.roomId, name: `Sala ${this.roomId.slice(0,4)}` }, 
                   { onConflict: 'room_id' });
        
        if (error) console.error('Erro ao criar sala:', error);
    }

    // 🔥 INICIAR COMPARTILHAMENTO
    startSharing() {
        if (this.isSharing) return;
        
        if (!navigator.geolocation) {
            this.showToast('Geolocalização não suportada', 'error');
            return;
        }

        this.watchId = navigator.geolocation.watchPosition(
            pos => this.onLocationUpdate(pos),
            err => this.onLocationError(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
        );

        this.isSharing = true;
        this.updateUI(true);
        this.updateStatus('📍 Compartilhando...', 'Localização ativa', '#45b7d1');
        this.showToast('✅ Compartilhamento iniciado!', 'success');
    }

    // 🔥 PARAR COMPARTILHAMENTO
    async stopSharing() {
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }

        await this.supabase
            .from('family_locations')
            .update({ online: false, updated_at: new Date().toISOString() })
            .eq('user_id', this.userId)
            .eq('room_id', this.roomId);

        this.isSharing = false;
        this.updateUI(false);
        this.removeUserMarker();
        this.updateStatus('⏹️ Parado', 'Compartilhamento pausado', '#ff6b6b');
        this.showToast('🛑 Compartilhamento parado', 'info');
    }

    // 🔥 ATUALIZAR LOCALIZAÇÃO
    async onLocationUpdate(position) {
        const { latitude, longitude, accuracy } = position.coords;
        const now = new Date().toISOString();

        const { error } = await this.supabase
            .from('family_locations')
            .upsert({
                room_id: this.roomId,
                user_id: this.userId,
                user_name: this.userName,
                latitude,
                longitude,
                accuracy,
                online: true,
                updated_at: now,
                created_at: now
            }, { onConflict: 'user_id,room_id' });

        if (!error) {
            this.updateUserMarker(latitude, longitude);
            this.map.setView([latitude, longitude], 16);
        }
    }

    onLocationError(error) {
        console.error('Erro GPS:', error);
        this.updateStatus('❌ Erro GPS', error.message, '#ff6b6b');
    }

    updateUserMarker(lat, lng) {
        if (this.userMarker) {
            this.userMarker.setLatLng([lat, lng]);
        } else {
            this.userMarker = L.marker([lat, lng], {
                icon: L.divIcon({
                    className: 'user-icon',
                    html: `<div style="background:#667eea;color:white;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:bold;box-shadow:0 4px 12px rgba(102,126,234,0.4);">👤</div>`,
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                })
            }).addTo(this.map);
        }
    }

    removeUserMarker() {
        if (this.userMarker) {
            this.map.removeLayer(this.userMarker);
            this.userMarker = null;
        }
    }

    // 🔥 ESCUTAR FAMÍLIA (Realtime)
    listenToFamily() {
        this.supabase
            .channel('family_locations')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'family_locations', filter: `room_id=eq.${this.roomId}` },
                payload => this.onFamilyUpdate(payload)
            )
            .subscribe();
    }

    async onFamilyUpdate(payload) {
        const familyData = await this.getFamilyData();
        this.updateFamilyMarkers(familyData);
        this.updateFamilyList(familyData);
    }

    async getFamilyData() {
        const { data } = await this.supabase
            .from('family_locations')
            .select('*')
            .eq('room_id', this.roomId)
            .order('updated_at', { ascending: false });

        // Filtrar online (últimos 30s) e remover usuário atual
        const now = new Date();
        return (data || [])
            .filter(loc => {
                const timeDiff = (now - new Date(loc.updated_at)) / 1000;
                return loc.user_id !== this.userId && timeDiff < 30;
            })
            .map(loc => ({
                ...loc,
                isOnline: true,
                timeAgo: this.formatTimeAgo(loc.updated_at)
            }));
    }

    updateFamilyMarkers(familyData) {
        // Limpar marcadores antigos
        this.familyMarkers.forEach(marker => this.map.removeLayer(marker));
        this.familyMarkers.clear();

        familyData.forEach(data => {
            const marker = L.marker([data.latitude, data.longitude], {
                icon: L.divIcon({
                    className: 'family-icon',
                    html: `<div style="background:#ff6b6b;color:white;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:bold;box-shadow:0 4px 12px rgba(255,107,107,0.4);">👨‍👩‍👧</div>`,
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                })
            }).addTo(this.map);

            marker.bindPopup(`
                <b>${data.user_name}</b><br>
                📍 ${data.accuracy?.toFixed(0)}m precisão<br>
                🕐 ${data.timeAgo}<br>
                <small>${new Date(data.updated_at).toLocaleString()}</small>
            `);

            this.familyMarkers.set(data.user_id, marker);
        });
    }

    updateFamilyList(familyData) {
        const familyList = document.getElementById('familyList');
        const onlineCount = document.getElementById('onlineCount');
        
        onlineCount.textContent = familyData.length;
        familyList.innerHTML = '';

        familyData.forEach(data => {
            const div = document.createElement('div');
            div.className = `family-member online`;
            div.innerHTML = `
                <div class="family-avatar" style="background: linear-gradient(135deg, #4ecdc4, #44bdad);">
                    ${data.user_name.charAt(0).toUpperCase()}
                </div>
                <div class="family-info">
                    <h4>${data.user_name}</h4>
                    <p><i class="fas fa-circle" style="color:#4ecdc4"></i> Online • ${data.timeAgo}</p>
                </div>
            `;
            familyList.appendChild(div);
        });
    }

    formatTimeAgo(dateStr) {
        const diff = (new Date() - new Date(dateStr)) / 1000;
        if (diff < 60) return 'agora';
        if (diff < 3600) return `${Math.floor(diff/60)}min`;
        return `${