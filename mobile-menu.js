/**
 * Mobile menu toggle functionality
 * Adds mobile-friendly navigation to the website
 */

document.addEventListener('DOMContentLoaded', function() {
  const menuToggle = document.querySelector('.mobile-menu-toggle');
  const mobileMenu = document.querySelector('.mobile-menu');
  const hamburger = document.querySelector('.hamburger');
  
  if (menuToggle && mobileMenu) {
    // Toggle menu on button click
    menuToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      mobileMenu.classList.toggle('active');
      
      // Close menu when clicking on a link
      const links = mobileMenu.querySelectorAll('a');
      links.forEach(link => {
        link.addEventListener('click', function() {
          mobileMenu.classList.remove('active');
        });
      });
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', function(event) {
      if (!mobileMenu.contains(event.target) && !menuToggle.contains(event.target)) {
        mobileMenu.classList.remove('active');
      }
    });
    
    // Close menu when pressing Escape key
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && mobileMenu.classList.contains('active')) {
        mobileMenu.classList.remove('active');
      }
    });
  }
});