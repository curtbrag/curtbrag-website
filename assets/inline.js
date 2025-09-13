const avatarImgs = [
      'assets/otis_avatar.png',
      'assets/otis_avatar.png',
      'assets/otis_avatar.png'
    ];
    let avatarIndex = 0;
    const avatarEl = document.getElementById('avatarImg');
    if (avatarEl) {
      avatarEl.addEventListener('click', () => {
        avatarIndex = (avatarIndex + 1) % avatarImgs.length;
        avatarEl.src = avatarImgs[avatarIndex];
      });
    }
