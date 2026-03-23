class FamilyLocator {
    constructor() {
        // SUAS CREDENCIAIS (já colocadas)
        const supabaseUrl = 'https://epijxziihqnhwghiuuej.supabase.co';
        const supabaseKey = 'sb_publishable_jhEJpUlCTOX6sDsyn5_z_w_6iLEoHFs'; // ⚠️ se não funcionar, troque pela chave ANON real (começa com eyJ...)

        this.supabase = supabase.createClient(supabaseUrl, supabaseKey);

        this.map = null;
        this.userMarker = null;
        this.familyMarkers = new Map();
        this.watchId = null;
        this.isSharing = false;
        this.userId = crypto.randomUUID();
        this.userName = localStorage.getItem('familyName') || prompt('👤 Seu nome na famíli:') || 'Membro';
        localStorage.setItem('familyName', this.userName);

        // Sala (mantém o mesmo link ao recarregar)
        const params = new URLSearchParams(location.search);
        this.roomId = params.get('room') || crypto.randomUUID().slice(0, 8);
        if (!params.get('room')) history.replaceState(null, '', `?room=${this.roomId}`);

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadMap();
        await this.createRoom();
        this.listenToFamily();
        this.updateStatus('🟢 Conectado!', 'Clique em Iniciar Compartilhamento', '#4ecdc4');
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
            attribution: '© OpenStreetMap'
        }).addTo(this.map);
    }

    async createRoom() {
        await this.supabase.from('family_rooms').upsert({ room_id: this.roomId, name: `Sala ${this.roomId}` });
    }

    updateStatus(title, message, color = '#4ecdc4') {
        document.getElementById('statusTitle').textContent = title;
        document.getElementById('statusMessage').textContent = message;
        document.getElementById('statusIcon').style.color = color;
    }

    showToast(msg, type = 'success') {
        const toast = document.createElement('div');
        toast.style.cssText = `position:fixed;bottom:30px;left:50%;transform:translateX(-50%);padding:15px 25px;border-radius:12px;color:white;font-weight:600;z-index:9999;background:${type==='success'?'#4ecdc4':type==='error'?'#ff6b6b':'#667eea'};`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    updateUI(sharing) {
        document.getElementById('shareBtn').style.display = sharing ? 'none' : 'block';
        document.getElementById('stopBtn').style.display = sharing ? 'block' : 'none';
        document.getElementById('mapContainer').style.display = sharing ? 'block' : 'none';
        document.getElementById('familySection').style.display = sharing ? 'block' : 'none';
        document.getElementById('qrSection').style.display = sharing ? 'block' : 'none';
    }

    startSharing() {
        if (this.isSharing) return;
        if (!navigator.geolocation) return this.showToast('Geolocalização não suportada', 'error');

        this.watchId = navigator.geolocation.watchPosition(
            pos => this.onLocationUpdate(pos),
            err => this.onLocationError(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );

        this.isSharing = true;
        this.updateUI(true);
        this.updateStatus('📍 Compartilhando...', 'Localização em tempo real', '#45b7d1');
        this.showToast('✅ Compartilhamento iniciado!');
    }

    async stopSharing() {
        if (this.watchId) navigator.geolocation.clearWatch(this.watchId);
        await this.supabase.from('family_locations').update({ online: false }).eq('user_id', this.userId).eq('room_id', this.roomId);
        this.isSharing = false;
        this.updateUI(false);
        if (this.userMarker) this.map.removeLayer(this.userMarker);
        this.updateStatus('⏹️ Parado', 'Compartilhamento encerrado', '#ff6b6b');
        this.showToast('🛑 Compartilhamento parado');
    }

    async onLocationUpdate(position) {
        const { latitude, longitude, accuracy } = position.coords;
        const now = new Date().toISOString();

        await this.supabase.from('family_locations').upsert({
            room_id: this.roomId,
            user_id: this.userId,
            user_name: this.userName,
            latitude, longitude, accuracy,
            online: true,
            updated_at: now
        });

        this.updateUserMarker(latitude, longitude);
        this.map.setView([latitude, longitude], 16);
    }

    onLocationError(err) {
        this.showToast('Erro no GPS: ' + err.message, 'error');
    }

    updateUserMarker(lat, lng) {
        if (this.userMarker) {
            this.userMarker.setLatLng([lat, lng]);
        } else {
            this.userMarker = L.marker([lat, lng], {
                icon: L.divIcon({ className: 'user-icon', html: '👤', iconSize: [40, 40] })
            }).addTo(this.map);
        }
    }

    listenToFamily() {
        this.supabase.channel('family')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'family_locations', filter: `room_id=eq.${this.roomId}` },
                () => this.refreshFamily())
            .subscribe();
    }

    async refreshFamily() {
        const { data } = await this.supabase
            .from('family_locations')
            .select('*')
            .eq('room_id', this.roomId)
            .order('updated_at', { ascending: false });

        const now = Date.now();
        const family = (data || []).filter(loc => {
            const age = (now - new Date(loc.updated_at)) / 1000;
            return loc.user_id !== this.userId && age < 180; // 3 minutos
        });

        this.updateFamilyMarkers(family);
        this.updateFamilyList(family);
    }

    updateFamilyMarkers(family) {
        this.familyMarkers.forEach(m => this.map.removeLayer(m));
        this.familyMarkers.clear();

        family.forEach(loc => {
            const marker = L.marker([loc.latitude, loc.longitude], {
                icon: L.divIcon({ html: '👨‍👩‍👧', iconSize: [36, 36] })
            }).addTo(this.map);
            this.familyMarkers.set(loc.user_id, marker);
        });
    }

    updateFamilyList(family) {
        const list = document.getElementById('familyList');
        const count = document.getElementById('onlineCount');
        count.textContent = family.length;
        list.innerHTML = '';

        family.forEach(m => {
            const div = document.createElement('div');
            div.className = 'family-member online';
            div.innerHTML = `
                <div class="family-avatar" style="background:#4ecdc4">${m.user_name[0]}</div>
                <div class="family-info">
                    <h4>${m.user_name}</h4>
                    <p><i class="fas fa-circle"></i> Online • agora</p>
                </div>`;
            list.appendChild(div);
        });
    }

    generateQR() {
        const link = `${location.origin}${location.pathname}?room=${this.roomId}`;
        document.getElementById('shareLink').value = link;

        const qrDiv = document.getElementById('qrCode');
        qrDiv.innerHTML = '';
        new QRCode(qrDiv, { text: link, width: 200, height: 200 });
    }

    copyLink() {
        const link = document.getElementById('shareLink').value;
        navigator.clipboard.writeText(link);
        this.showToast('✅ Link copiado!');
    }
}

// Inicia a aplicação
new FamilyLocator();